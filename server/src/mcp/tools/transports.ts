import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { canAccessTrip } from '../../db/database';
import { isDemoUser } from '../../services/authService';
import {
  createReservation, deleteReservation, getReservation, updateReservation,
  type EndpointInput,
} from '../../services/reservationService';
import { linkBudgetItemToReservation } from '../../services/budgetService';
import { getDay } from '../../services/dayService';
import { findByIata } from '../../services/airportService';
import { flightLegSchema, type FlightLeg } from '@trek/shared';
import {
  safeBroadcast, TOOL_ANNOTATIONS_DELETE, TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  TOOL_ANNOTATIONS_WRITE, demoDenied, noAccess, ok, hasTripPermission, permissionDenied,
} from './_shared';
import { canWrite } from '../scopes';

const TRANSPORT_TYPES = ['flight', 'train', 'car', 'cruise'] as const;

const endpointObjectSchema = z.object({
  role: z.enum(['from', 'to', 'stop']).describe('Endpoint role: "from" (origin), "to" (destination), or "stop" (intermediate)'),
  sequence: z.number().int().min(0).describe('Order within the route (0-based)'),
  name: z.string().min(1).describe('Location name (e.g. "Paris Gare de Lyon", "ZRH Terminal 2")'),
  code: z.string().optional().describe('IATA airport code for flights (e.g. "ZRH"). Leave empty for other transport types.'),
  lat: z.number().optional().describe('Latitude. For flights, leave empty and set code instead — coordinates are filled from the airport.'),
  lng: z.number().optional().describe('Longitude. For flights, leave empty and set code instead — coordinates are filled from the airport.'),
  timezone: z.string().optional().describe('IANA timezone (e.g. "Europe/Zurich"). Use airport tz for flights.'),
  local_time: z.string().optional().describe('Local departure/arrival time at this endpoint, e.g. "14:35"'),
  local_date: z.string().optional().describe('Local date at this endpoint, YYYY-MM-DD'),
});
const endpointSchema = z.array(endpointObjectSchema).optional();

type Endpoint = z.infer<typeof endpointObjectSchema>;

/**
 * Endpoint coordinates are stored NOT NULL. Callers may supply a flight endpoint
 * with only an IATA `code` (the tool description encourages this), so fill missing
 * lat/lng/timezone from the airport database. Returns an error string for the first
 * endpoint that can't be resolved rather than letting the NOT NULL bind throw.
 *
 * Normalizes to the service's EndpointInput shape (nullable fields coerced from the
 * schema's optionals), so lat/lng are guaranteed present before the insert.
 */
function resolveEndpointCoords(endpoints: Endpoint[] | undefined): { endpoints: EndpointInput[] } | { error: string } {
  if (!endpoints) return { endpoints: [] };
  const out: EndpointInput[] = [];
  for (const e of endpoints) {
    const base = {
      role: e.role,
      sequence: e.sequence,
      name: e.name,
      code: e.code ?? null,
      timezone: e.timezone ?? null,
      local_time: e.local_time ?? null,
      local_date: e.local_date ?? null,
    };
    if (e.lat != null && e.lng != null) { out.push({ ...base, lat: e.lat, lng: e.lng }); continue; }
    if (e.code) {
      const airport = findByIata(e.code);
      if (airport) {
        out.push({ ...base, lat: airport.lat, lng: airport.lng, timezone: e.timezone ?? airport.tz });
        continue;
      }
      return { error: `Could not resolve airport code "${e.code}". Use search_airports to find a valid IATA code, or supply lat/lng directly.` };
    }
    return { error: `Endpoint "${e.name}" is missing coordinates. For flights set "code" to the IATA airport code; for other transport types supply lat/lng.` };
  }
  return { endpoints: out };
}

/**
 * Derive everything a multi-leg flight needs from a typed `legs[]` array, so an
 * agent can describe a layover (FRA→BER→HND) without hand-building endpoints or
 * the metadata.legs contract. For N legs we emit N+1 waypoints: `from` (seq 0)
 * departs legs[0]; each `stop` i (1..N-1) is legs[i]'s origin departing legs[i];
 * `to` (seq N) is the last leg's destination arriving at last.arr_time. IATA
 * codes resolve to name/lat/lng/timezone via the airport DB (same lookup as the
 * web client and booking import), day_id/end_day_id mirror the first/last leg,
 * and the top-level metadata mirrors the fields legacy readers expect. Returns
 * an error string for the first unresolvable airport or trip-foreign day.
 */
function buildLegsTransport(legs: FlightLeg[], tripId: number):
  | { endpoints: EndpointInput[]; metaPatch: Record<string, unknown>; day_id: number | null; end_day_id: number | null }
  | { error: string } {
  const dayDate = (dayId: number | null | undefined): { date: string | null } | { error: string } => {
    if (dayId == null) return { date: null };
    const day = getDay(dayId, tripId) as { date?: string } | undefined;
    if (!day) return { error: `day_id ${dayId} does not belong to this trip.` };
    return { date: day.date ?? null };
  };

  // Resolve an IATA code into a persistable endpoint at the given sequence/role.
  const makeEndpoint = (code: string, role: 'from' | 'stop' | 'to', sequence: number, time: string | null | undefined, date: string | null): EndpointInput | { error: string } => {
    const airport = findByIata(code);
    if (!airport) return { error: `Could not resolve airport code "${code}". Use search_airports to find a valid IATA code.` };
    return {
      role, sequence,
      name: airport.city ? `${airport.city} (${airport.iata})` : airport.name,
      code: airport.iata, lat: airport.lat, lng: airport.lng, timezone: airport.tz,
      local_time: time ?? null, local_date: date,
    };
  };

  const endpoints: EndpointInput[] = [];
  const first = legs[0];
  const last = legs[legs.length - 1];

  const firstDep = dayDate(first.dep_day_id);
  if ('error' in firstDep) return firstDep;
  const fromEp = makeEndpoint(first.from, 'from', 0, first.dep_time, firstDep.date);
  if ('error' in fromEp) return fromEp;
  endpoints.push(fromEp);

  // Each connection (the origin of legs[1..N-1]) becomes a stop.
  for (let i = 1; i < legs.length; i++) {
    const dep = dayDate(legs[i].dep_day_id);
    if ('error' in dep) return dep;
    const stop = makeEndpoint(legs[i].from, 'stop', i, legs[i].dep_time, dep.date);
    if ('error' in stop) return stop;
    endpoints.push(stop);
  }

  const lastArr = dayDate(last.arr_day_id);
  if ('error' in lastArr) return lastArr;
  const toEp = makeEndpoint(last.to, 'to', legs.length, last.arr_time, lastArr.date);
  if ('error' in toEp) return toEp;
  endpoints.push(toEp);

  const metaPatch: Record<string, unknown> = { legs, departure_airport: first.from, arrival_airport: last.to };
  if (first.airline) metaPatch.airline = first.airline;
  if (first.flight_number) metaPatch.flight_number = first.flight_number;

  return { endpoints, metaPatch, day_id: first.dep_day_id ?? null, end_day_id: last.arr_day_id ?? null };
}

const legsSchema = z.array(flightLegSchema).min(1).optional().describe('Multi-leg flight segments (FRA→BER→HND). When set on a flight, endpoints, metadata.legs, the mirrored top-level metadata, and day_id/end_day_id are all derived automatically — do NOT also pass endpoints. Each leg carries its own airline, flight_number, departure and arrival day/time.');

export function registerTransportTools(server: McpServer, userId: number, scopes: string[] | null): void {
  if (!canWrite(scopes, 'reservations')) return;

  server.registerTool(
    'create_transport',
    {
      description: 'Create a transport booking (flight, train, car, or cruise) for a trip. Use endpoints[] to record origin/destination and intermediate stops — for flights, set code to the IATA airport code (use search_airports first). Created as pending — confirm with update_transport. Set price to record the cost; it will appear on the booking and in the Budget tab.',
      inputSchema: {
        tripId: z.number().int().positive(),
        type: z.enum(['flight', 'train', 'car', 'cruise']),
        title: z.string().min(1).max(200),
        status: z.enum(['pending', 'confirmed', 'cancelled']).optional().default('pending'),
        start_day_id: z.number().int().positive().optional().describe('Departure day'),
        end_day_id: z.number().int().positive().optional().describe('Arrival day (if different from departure)'),
        reservation_time: z.string().optional().describe('ISO 8601 datetime or time string for departure'),
        reservation_end_time: z.string().optional().describe('ISO 8601 datetime or time string for arrival'),
        confirmation_number: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
        metadata: z.record(z.string(), z.string()).optional().describe('Type-specific metadata: flights → { airline, flight_number, departure_airport, arrival_airport }; trains → { train_number, platform, seat }'),
        endpoints: endpointSchema,
        legs: legsSchema,
        needs_review: z.boolean().optional(),
        price: z.number().nonnegative().optional().describe('Transport cost — shown on the booking and linked in the Budget tab'),
        budget_category: z.string().max(100).optional().describe('Budget category for the price entry (defaults to transport type)'),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, type, title, status, start_day_id, end_day_id, reservation_time, reservation_end_time, confirmation_number, notes, metadata, endpoints, legs, needs_review, price, budget_category }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!hasTripPermission('reservation_edit', tripId, userId)) return permissionDenied();

      if (start_day_id && !getDay(start_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'start_day_id does not belong to this trip.' }], isError: true };
      if (end_day_id && !getDay(end_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'end_day_id does not belong to this trip.' }], isError: true };

      const meta: Record<string, unknown> = { ...(metadata ?? {}) };
      if (price != null) meta.price = String(price);

      // A flight described by legs derives its own endpoints + metadata.legs and
      // overrides day_id/end_day_id; the caller should not also pass endpoints.
      let resolvedEndpoints: EndpointInput[];
      let day_id = start_day_id;
      let end = end_day_id ?? start_day_id;
      if (legs && legs.length > 0) {
        if (type !== 'flight')
          return { content: [{ type: 'text' as const, text: 'legs are only supported for type "flight". Use endpoints for other transport types.' }], isError: true };
        const built = buildLegsTransport(legs, tripId);
        if ('error' in built) return { content: [{ type: 'text' as const, text: built.error }], isError: true };
        resolvedEndpoints = built.endpoints;
        Object.assign(meta, built.metaPatch);
        day_id = built.day_id ?? start_day_id;
        end = built.end_day_id ?? end_day_id ?? start_day_id;
      } else {
        const resolved = resolveEndpointCoords(endpoints);
        if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }], isError: true };
        resolvedEndpoints = resolved.endpoints;
      }

      const { reservation } = createReservation(tripId, {
        title,
        type,
        reservation_time,
        reservation_end_time,
        location: undefined,
        confirmation_number,
        notes,
        day_id,
        end_day_id: end,
        status: status ?? 'pending',
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
        endpoints: resolvedEndpoints,
        needs_review,
      });

      if (price != null && price > 0) {
        const item = linkBudgetItemToReservation(tripId, reservation.id, {
          name: title,
          category: budget_category || type,
          total_price: price,
        });
        safeBroadcast(tripId, 'budget:created', { item });
      }

      safeBroadcast(tripId, 'reservation:created', { reservation });
      return ok({ reservation });
    }
  );

  server.registerTool(
    'update_transport',
    {
      description: 'Update an existing transport booking. Pass endpoints[] to replace the full list of stops (origin, destination, intermediates). Use status "confirmed" to confirm.',
      inputSchema: {
        tripId: z.number().int().positive(),
        reservationId: z.number().int().positive(),
        type: z.enum(['flight', 'train', 'car', 'cruise']).optional(),
        title: z.string().min(1).max(200).optional(),
        status: z.enum(['pending', 'confirmed', 'cancelled']).optional(),
        start_day_id: z.number().int().positive().optional().describe('Departure day'),
        end_day_id: z.number().int().positive().optional().describe('Arrival day (if different from departure)'),
        reservation_time: z.string().optional().describe('ISO 8601 datetime or time string for departure'),
        reservation_end_time: z.string().optional().describe('ISO 8601 datetime or time string for arrival'),
        confirmation_number: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
        metadata: z.record(z.string(), z.string()).optional().describe('Type-specific metadata: flights → { airline, flight_number, departure_airport, arrival_airport }; trains → { train_number, platform, seat }'),
        endpoints: endpointSchema,
        legs: legsSchema,
        needs_review: z.boolean().optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, reservationId, type, title, status, start_day_id, end_day_id, reservation_time, reservation_end_time, confirmation_number, notes, metadata, endpoints, legs, needs_review }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!hasTripPermission('reservation_edit', tripId, userId)) return permissionDenied();

      const existing = getReservation(reservationId, tripId);
      if (!existing) return { content: [{ type: 'text' as const, text: 'Transport not found.' }], isError: true };

      const resolvedType = type ?? existing.type;
      if (!(TRANSPORT_TYPES as readonly string[]).includes(resolvedType))
        return { content: [{ type: 'text' as const, text: 'Reservation is not a transport type. Use update_reservation instead.' }], isError: true };

      if (start_day_id && !getDay(start_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'start_day_id does not belong to this trip.' }], isError: true };
      if (end_day_id && !getDay(end_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'end_day_id does not belong to this trip.' }], isError: true };

      // Only resolve when endpoints/legs are explicitly provided; undefined leaves them untouched.
      let resolvedEndpoints: EndpointInput[] | undefined;
      let metaForUpdate: Record<string, unknown> | undefined = metadata;
      let day_id = start_day_id;
      let end = end_day_id;
      if (legs && legs.length > 0) {
        if (resolvedType !== 'flight')
          return { content: [{ type: 'text' as const, text: 'legs are only supported for type "flight". Use endpoints for other transport types.' }], isError: true };
        const built = buildLegsTransport(legs, tripId);
        if ('error' in built) return { content: [{ type: 'text' as const, text: built.error }], isError: true };
        resolvedEndpoints = built.endpoints;
        // Merge existing metadata (e.g. price) with any provided flat metadata,
        // then overlay the derived legs/mirror so the contract stays fresh.
        let existingMeta: Record<string, unknown> = {};
        if (existing.metadata) {
          try { existingMeta = JSON.parse(existing.metadata) || {}; } catch { existingMeta = {}; }
          if (typeof existingMeta !== 'object' || existingMeta === null) existingMeta = {};
        }
        metaForUpdate = { ...existingMeta, ...(metadata ?? {}), ...built.metaPatch };
        day_id = built.day_id ?? start_day_id;
        end = built.end_day_id ?? end_day_id;
      } else if (endpoints !== undefined) {
        const resolved = resolveEndpointCoords(endpoints);
        if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }], isError: true };
        resolvedEndpoints = resolved.endpoints;
      }

      const { reservation } = updateReservation(reservationId, tripId, {
        title,
        type,
        reservation_time,
        reservation_end_time,
        confirmation_number,
        notes,
        day_id,
        end_day_id: end,
        status,
        metadata: metaForUpdate,
        endpoints: resolvedEndpoints,
        needs_review,
      }, existing);
      safeBroadcast(tripId, 'reservation:updated', { reservation });
      return ok({ reservation });
    }
  );

  server.registerTool(
    'delete_transport',
    {
      description: 'Delete a transport booking from a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        reservationId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, reservationId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!hasTripPermission('reservation_edit', tripId, userId)) return permissionDenied();
      const { deleted } = deleteReservation(reservationId, tripId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Transport not found.' }], isError: true };
      safeBroadcast(tripId, 'reservation:deleted', { reservationId });
      return ok({ success: true });
    }
  );
}
