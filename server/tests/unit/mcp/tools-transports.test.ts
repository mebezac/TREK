/**
 * Unit tests for MCP transport tools: create_transport, update_transport, delete_transport.
 * Focus: flight endpoints supplied with only an IATA `code` are backfilled with
 * lat/lng/timezone from the airport database (the columns are NOT NULL), and
 * endpoints that can't be resolved produce a clean error instead of a SQL crash.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: () => null,
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));
vi.mock('../../../src/websocket', () => ({ broadcast: broadcastMock }));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser, createTrip } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, type McpHarness } from '../../helpers/mcp-harness';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  broadcastMock.mockClear();
  delete process.env.DEMO_MODE;
});

afterAll(() => {
  testDb.close();
});

async function withHarness(userId: number, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withResources: false });
  try { await fn(h); } finally { await h.cleanup(); }
}

const flightEndpoints = [
  { role: 'from', sequence: 0, name: 'Zurich', code: 'ZRH' },
  { role: 'to', sequence: 1, name: 'Paris CDG', code: 'CDG' },
];

describe('Tool: create_transport', () => {
  it('backfills lat/lng/timezone for code-only flight endpoints', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_transport',
        arguments: { tripId: trip.id, type: 'flight', title: 'ZRH → CDG', endpoints: flightEndpoints },
      });
      const data = parseToolResult(result) as any;
      const eps = data.reservation.endpoints;
      expect(eps).toHaveLength(2);
      const from = eps.find((e: any) => e.role === 'from');
      expect(typeof from.lat).toBe('number');
      expect(typeof from.lng).toBe('number');
      expect(from.timezone).toBe('Europe/Zurich');
      // persisted NOT NULL columns are populated
      const rows = testDb.prepare('SELECT lat, lng FROM reservation_endpoints WHERE reservation_id = ?').all(data.reservation.id) as any[];
      expect(rows.every(r => r.lat != null && r.lng != null)).toBe(true);
    });
  });

  it('keeps manually-supplied coordinates and the caller timezone', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_transport',
        arguments: {
          tripId: trip.id, type: 'train', title: 'Scenic train',
          endpoints: [
            { role: 'from', sequence: 0, name: 'Station A', lat: 46.0, lng: 7.0, timezone: 'Europe/Zurich' },
            { role: 'to', sequence: 1, name: 'Station B', lat: 46.5, lng: 7.5 },
          ],
        },
      });
      const data = parseToolResult(result) as any;
      const from = data.reservation.endpoints.find((e: any) => e.role === 'from');
      expect(from.lat).toBe(46.0);
      expect(from.timezone).toBe('Europe/Zurich');
    });
  });

  it('errors on an unresolvable airport code instead of crashing', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_transport',
        arguments: {
          tripId: trip.id, type: 'flight', title: 'Bad flight',
          endpoints: [{ role: 'from', sequence: 0, name: 'Nowhere', code: 'ZZZ' }],
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain('ZZZ');
    });
  });

  it('errors on an endpoint missing both coordinates and a code', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_transport',
        arguments: {
          tripId: trip.id, type: 'car', title: 'Road trip',
          endpoints: [{ role: 'from', sequence: 0, name: 'My house' }],
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain('missing coordinates');
    });
  });

  it('creates a transport with no endpoints', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_transport',
        arguments: { tripId: trip.id, type: 'flight', title: 'TBD flight' },
      });
      const data = parseToolResult(result) as any;
      expect(data.reservation.title).toBe('TBD flight');
    });
  });
});

describe('Tool: update_transport', () => {
  it('backfills coords when replacing endpoints', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const created = parseToolResult(await h.client.callTool({
        name: 'create_transport',
        arguments: { tripId: trip.id, type: 'flight', title: 'F', endpoints: flightEndpoints },
      })) as any;
      const result = await h.client.callTool({
        name: 'update_transport',
        arguments: {
          tripId: trip.id, reservationId: created.reservation.id,
          endpoints: [
            { role: 'from', sequence: 0, name: 'JFK', code: 'JFK' },
            { role: 'to', sequence: 1, name: 'Zurich', code: 'ZRH' },
          ],
        },
      });
      const data = parseToolResult(result) as any;
      const from = data.reservation.endpoints.find((e: any) => e.role === 'from');
      expect(from.code).toBe('JFK');
      expect(typeof from.lat).toBe('number');
    });
  });

  it('leaves endpoints untouched when not provided', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const created = parseToolResult(await h.client.callTool({
        name: 'create_transport',
        arguments: { tripId: trip.id, type: 'flight', title: 'F', endpoints: flightEndpoints },
      })) as any;
      const result = await h.client.callTool({
        name: 'update_transport',
        arguments: { tripId: trip.id, reservationId: created.reservation.id, status: 'confirmed' },
      });
      const data = parseToolResult(result) as any;
      expect(data.reservation.status).toBe('confirmed');
      expect(data.reservation.endpoints).toHaveLength(2);
    });
  });
});

describe('Multi-leg flights (legs[])', () => {
  // Two-leg layover FRA -> BER -> HND. Each leg carries its own time + carrier.
  const legs = [
    { from: 'FRA', to: 'BER', airline: 'Lufthansa', flight_number: 'LH1', dep_time: '08:00', arr_time: '09:00' },
    { from: 'BER', to: 'HND', airline: 'ANA', flight_number: 'NH2', dep_time: '10:00', arr_time: '20:00' },
  ];

  it('derives N+1 endpoints with per-leg times from N legs', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const data = parseToolResult(await h.client.callTool({
        name: 'create_transport',
        arguments: { tripId: trip.id, type: 'flight', title: 'FRA → HND', legs },
      })) as any;
      const eps = data.reservation.endpoints.sort((a: any, b: any) => a.sequence - b.sequence);
      expect(eps.map((e: any) => e.code)).toEqual(['FRA', 'BER', 'HND']);
      expect(eps.map((e: any) => e.role)).toEqual(['from', 'stop', 'to']);
      // from departs leg0, the stop departs leg1, the destination arrives leg1
      expect(eps[0].local_time).toBe('08:00');
      expect(eps[1].local_time).toBe('10:00');
      expect(eps[2].local_time).toBe('20:00');
      // code-only legs are backfilled with airport coords (NOT NULL columns)
      expect(eps.every((e: any) => typeof e.lat === 'number' && typeof e.lng === 'number')).toBe(true);
    });
  });

  it('stores metadata.legs intact and mirrors first/last leg to top-level metadata', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const data = parseToolResult(await h.client.callTool({
        name: 'create_transport',
        arguments: { tripId: trip.id, type: 'flight', title: 'FRA → HND', legs },
      })) as any;
      const meta = JSON.parse(data.reservation.metadata);
      expect(meta.legs).toHaveLength(2);
      expect(meta.legs[0]).toMatchObject({ from: 'FRA', to: 'BER', airline: 'Lufthansa', flight_number: 'LH1' });
      expect(meta.departure_airport).toBe('FRA');
      expect(meta.arrival_airport).toBe('HND');
      expect(meta.airline).toBe('Lufthansa');
      expect(meta.flight_number).toBe('LH1');
    });
  });

  it('errors on an unresolvable airport code in a leg', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_transport',
        arguments: { tripId: trip.id, type: 'flight', title: 'Bad', legs: [{ from: 'ZZZ', to: 'CDG' }] },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain('ZZZ');
    });
  });

  it('rejects legs on a non-flight transport type', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_transport',
        arguments: { tripId: trip.id, type: 'train', title: 'Nope', legs: [{ from: 'FRA', to: 'BER' }] },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain('flight');
    });
  });

  it('update_transport replaces endpoints + legs from a new legs[] array', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const created = parseToolResult(await h.client.callTool({
        name: 'create_transport',
        arguments: { tripId: trip.id, type: 'flight', title: 'F', endpoints: flightEndpoints },
      })) as any;
      const data = parseToolResult(await h.client.callTool({
        name: 'update_transport',
        arguments: { tripId: trip.id, reservationId: created.reservation.id, legs },
      })) as any;
      expect(data.reservation.endpoints).toHaveLength(3);
      const meta = JSON.parse(data.reservation.metadata);
      expect(meta.legs).toHaveLength(2);
    });
  });
});
