/**
 * Unit tests for MCP file tools: upload_file, list_files, link_file,
 * unlink_file, update_file, delete_file. Focus: bytes arrive via base64,
 * the REST file-type allowlist + trip-scoped ref checks are enforced, links
 * round-trip, and delete soft-deletes.
 */
import { runMigrations } from '../../../src/db/migrations';
import { createTables } from '../../../src/db/schema';
import { createUser, createTrip, createReservation } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, type McpHarness } from '../../helpers/mcp-harness';
import { resetTestDb } from '../../helpers/test-db';

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
      db
        .prepare(
          `SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`,
        )
        .get(userId, tripId, userId),
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
  try {
    await fn(h);
  } finally {
    await h.cleanup();
  }
}

const pdfBase64 = Buffer.from('%PDF-1.4 fake').toString('base64');

async function upload(h: McpHarness, tripId: number, args: Record<string, unknown> = {}) {
  return h.client.callTool({
    name: 'upload_file',
    arguments: { tripId, filename: 'confirmation.pdf', content_base64: pdfBase64, ...args },
  });
}

describe('Tool: upload_file', () => {
  it('stores a base64 document and returns the file record', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const data = parseToolResult(await upload(h, trip.id, { description: 'Hotel booking' })) as any;
      expect(data.file.original_name).toBe('confirmation.pdf');
      expect(data.file.description).toBe('Hotel booking');
      const row = testDb.prepare('SELECT * FROM trip_files WHERE id = ?').get(data.file.id) as any;
      expect(row.trip_id).toBe(trip.id);
      expect(row.file_size).toBeGreaterThan(0);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'file:created', expect.objectContaining({ _source: 'mcp' }));
    });
  });

  it('assigns the file to a reservation in the same trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const res = createReservation(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const data = parseToolResult(await upload(h, trip.id, { reservation_id: res.id })) as any;
      expect(data.file.reservation_id).toBe(res.id);
    });
  });

  it('rejects a reservation_id from another trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const otherTrip = createTrip(testDb, user.id);
    const foreign = createReservation(testDb, otherTrip.id);
    await withHarness(user.id, async (h) => {
      const result = await upload(h, trip.id, { reservation_id: foreign.id });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain('reservation_id does not belong');
    });
  });

  it('rejects a blocked file extension', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'upload_file',
        arguments: { tripId: trip.id, filename: 'malware.exe', content_base64: pdfBase64 },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain('File type not allowed');
    });
  });

  it('requires exactly one of content_base64 / source_url', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const neither = await h.client.callTool({
        name: 'upload_file',
        arguments: { tripId: trip.id, filename: 'x.pdf' },
      });
      expect(neither.isError).toBe(true);
      expect((neither.content as any)[0].text).toContain('either content_base64 or source_url');
    });
  });
});

describe('Tools: list_files / link_file / unlink_file', () => {
  it('lists uploaded files and round-trips an extra reservation link', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const res = createReservation(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const uploaded = parseToolResult(await upload(h, trip.id)) as any;
      const fileId = uploaded.file.id;

      const listed = parseToolResult(
        await h.client.callTool({ name: 'list_files', arguments: { tripId: trip.id } }),
      ) as any;
      expect(listed.files).toHaveLength(1);
      expect(listed.files[0].id).toBe(fileId);

      const linked = parseToolResult(
        await h.client.callTool({
          name: 'link_file',
          arguments: { tripId: trip.id, file_id: fileId, reservation_id: res.id },
        }),
      ) as any;
      const link = linked.links.find((l: any) => l.reservation_id === res.id);
      expect(link).toBeTruthy();

      const afterLink = parseToolResult(
        await h.client.callTool({ name: 'list_files', arguments: { tripId: trip.id } }),
      ) as any;
      expect(afterLink.files[0].linked_reservation_ids).toContain(res.id);

      const unlinked = parseToolResult(
        await h.client.callTool({
          name: 'unlink_file',
          arguments: { tripId: trip.id, file_id: fileId, link_id: link.id },
        }),
      ) as any;
      expect(unlinked.links.find((l: any) => l.id === link.id)).toBeFalsy();
    });
  });
});

describe('Tool: delete_file', () => {
  it('soft-deletes so the file only shows under trash', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const uploaded = parseToolResult(await upload(h, trip.id)) as any;
      await h.client.callTool({ name: 'delete_file', arguments: { tripId: trip.id, file_id: uploaded.file.id } });

      const active = parseToolResult(
        await h.client.callTool({ name: 'list_files', arguments: { tripId: trip.id } }),
      ) as any;
      expect(active.files).toHaveLength(0);

      const trashed = parseToolResult(
        await h.client.callTool({ name: 'list_files', arguments: { tripId: trip.id, trash: true } }),
      ) as any;
      expect(trashed.files).toHaveLength(1);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'file:deleted', expect.objectContaining({ _source: 'mcp' }));
    });
  });
});

describe('Scope gating', () => {
  it('does not register write tools for a read-only files scope', async () => {
    const { user } = createUser(testDb);
    const h = await createMcpHarness({ userId: user.id, withResources: false, scopes: ['files:read'] });
    try {
      const tools = (await h.client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('list_files');
      expect(tools).not.toContain('upload_file');
      expect(tools).not.toContain('delete_file');
    } finally {
      await h.cleanup();
    }
  });
});
