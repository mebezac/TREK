import { canAccessTrip } from '../../db/database';
import { placeExists } from '../../services/assignmentService';
import { isDemoUser } from '../../services/authService';
import {
  BLOCKED_EXTENSIONS,
  MAX_FILE_SIZE,
  createFile,
  createFileLink,
  deleteFileLink,
  filesDir,
  getAllowedExtensions,
  getFileById,
  getFileLinks,
  listFiles,
  softDeleteFile,
  updateFile,
} from '../../services/fileService';
import { getReservation } from '../../services/reservationService';
import { canRead, canWrite } from '../scopes';
import {
  safeBroadcast,
  TOOL_ANNOTATIONS_DELETE,
  TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  TOOL_ANNOTATIONS_READONLY,
  TOOL_ANNOTATIONS_WRITE,
  demoDenied,
  noAccess,
  ok,
  hasTripPermission,
  permissionDenied,
} from './_shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const textError = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/**
 * Mirror the REST upload's multer fileFilter (files.controller.ts): reject the
 * single authoritative blocklist + svg, then require the extension to be in the
 * admin allowlist (or `*` with the blocklist still enforced). Returns the
 * lower-cased extension (with leading dot) so the on-disk name can reuse it.
 */
function validateUploadType(originalname: string, mimetype: string): { ext: string } | { error: string } {
  const ext = path.extname(originalname).toLowerCase();
  if (BLOCKED_EXTENSIONS.includes(ext) || mimetype.includes('svg')) return { error: 'File type not allowed' };
  const allowed = getAllowedExtensions()
    .split(',')
    .map((e) => e.trim().toLowerCase());
  const fileExt = ext.replace('.', '');
  if (allowed.includes(fileExt) || (allowed.includes('*') && !BLOCKED_EXTENSIONS.includes(ext))) return { ext };
  return { error: 'File type not allowed' };
}

/** Validate that an optional reservation_id / place_id belongs to this trip. */
function checkTripRefs(
  tripId: number,
  reservation_id: number | undefined,
  place_id: number | undefined,
): { error: string } | null {
  if (reservation_id != null && !getReservation(reservation_id, tripId))
    return { error: 'reservation_id does not belong to this trip.' };
  if (place_id != null && !placeExists(place_id, tripId)) return { error: 'place_id does not belong to this trip.' };
  return null;
}

export function registerFileTools(server: McpServer, userId: number, scopes: string[] | null): void {
  const mayRead = canRead(scopes, 'files');
  const mayWrite = canWrite(scopes, 'files');
  const mayDelete = scopes === null || scopes.includes('files:delete');
  if (!mayRead && !mayWrite && !mayDelete) return;

  if (mayRead) {
    server.registerTool(
      'list_files',
      {
        description:
          'List the documents attached to a trip (confirmations, tickets, parking passes, etc.) with their primary reservation/place assignment and any additional links. Set trash:true to list soft-deleted files instead.',
        inputSchema: {
          tripId: z.number().int().positive(),
          trash: z
            .boolean()
            .optional()
            .default(false)
            .describe('List soft-deleted (trashed) files instead of active ones'),
        },
        annotations: TOOL_ANNOTATIONS_READONLY,
      },
      async ({ tripId, trash }) => {
        if (!canAccessTrip(tripId, userId)) return noAccess();
        return ok({ files: listFiles(tripId, trash ?? false) });
      },
    );
  }

  if (mayWrite) {
    server.registerTool(
      'upload_file',
      {
        description:
          'Upload a document to a trip and optionally link it to a reservation or place. Provide the bytes via either content_base64 (good for small confirmations) or source_url (the server fetches it — avoids large payloads). The same file-type allowlist and 50 MB limit as the web uploader apply.',
        inputSchema: {
          tripId: z.number().int().positive(),
          filename: z.string().min(1).max(255).describe('Original file name including extension, e.g. "parking.pdf"'),
          content_base64: z
            .string()
            .optional()
            .describe('Base64-encoded file bytes. Mutually exclusive with source_url.'),
          source_url: z
            .string()
            .url()
            .optional()
            .describe('URL the server fetches the file from. Mutually exclusive with content_base64.'),
          mime_type: z
            .string()
            .max(255)
            .optional()
            .describe('MIME type, e.g. "application/pdf". Inferred from the source_url response when omitted.'),
          description: z.string().max(1000).optional(),
          reservation_id: z.number().int().positive().optional().describe('Reservation to assign this file to'),
          place_id: z.number().int().positive().optional().describe('Place to assign this file to'),
        },
        annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
      },
      async ({ tripId, filename, content_base64, source_url, mime_type, description, reservation_id, place_id }) => {
        if (isDemoUser(userId)) return demoDenied();
        if (!canAccessTrip(tripId, userId)) return noAccess();
        if (!hasTripPermission('file_upload', tripId, userId)) return permissionDenied();

        if (!content_base64 && !source_url) return textError('Provide either content_base64 or source_url.');
        if (content_base64 && source_url)
          return textError('Provide only one of content_base64 or source_url, not both.');

        const refErr = checkTripRefs(tripId, reservation_id, place_id);
        if (refErr) return textError(refErr.error);

        // Acquire the bytes + a mime type.
        let buffer: Buffer;
        let mimetype = mime_type ?? 'application/octet-stream';
        if (content_base64) {
          try {
            buffer = Buffer.from(content_base64, 'base64');
          } catch {
            return textError('content_base64 is not valid base64.');
          }
          if (buffer.length === 0) return textError('Decoded file is empty.');
        } else {
          let res: Response;
          try {
            res = await fetch(source_url as string);
          } catch (e) {
            return textError(`Failed to fetch source_url: ${e instanceof Error ? e.message : 'unknown error'}`);
          }
          if (!res.ok) return textError(`source_url returned HTTP ${res.status}.`);
          const declared = Number(res.headers.get('content-length') ?? '0');
          if (declared && declared > MAX_FILE_SIZE) return textError(`File exceeds the ${MAX_FILE_SIZE} byte limit.`);
          buffer = Buffer.from(await res.arrayBuffer());
          if (buffer.length === 0) return textError('Fetched file is empty.');
          if (!mime_type) mimetype = res.headers.get('content-type')?.split(';')[0]?.trim() || mimetype;
        }

        if (buffer.length > MAX_FILE_SIZE) return textError(`File exceeds the ${MAX_FILE_SIZE} byte limit.`);

        const typeCheck = validateUploadType(filename, mimetype);
        if ('error' in typeCheck) return textError(typeCheck.error);

        // Persist to the same store the REST uploader uses: a uuid+ext on disk,
        // the original name kept as metadata.
        const diskName = `${randomUUID()}${typeCheck.ext}`;
        try {
          await fs.promises.mkdir(filesDir, { recursive: true });
          await fs.promises.writeFile(path.join(filesDir, diskName), buffer);
        } catch (e) {
          return textError(`Failed to store file: ${e instanceof Error ? e.message : 'unknown error'}`);
        }

        const file = createFile(
          tripId,
          { filename: diskName, originalname: filename, size: buffer.length, mimetype },
          userId,
          {
            reservation_id: reservation_id != null ? String(reservation_id) : null,
            place_id: place_id != null ? String(place_id) : null,
            description: description ?? null,
          },
        );
        safeBroadcast(tripId, 'file:created', { file });
        return ok({ file });
      },
    );

    server.registerTool(
      'link_file',
      {
        description:
          'Add an additional reservation or place link to an existing file (files can be linked to many reservations/places beyond their primary assignment).',
        inputSchema: {
          tripId: z.number().int().positive(),
          file_id: z.number().int().positive(),
          reservation_id: z.number().int().positive().optional(),
          place_id: z.number().int().positive().optional(),
        },
        annotations: TOOL_ANNOTATIONS_WRITE,
      },
      async ({ tripId, file_id, reservation_id, place_id }) => {
        if (isDemoUser(userId)) return demoDenied();
        if (!canAccessTrip(tripId, userId)) return noAccess();
        if (!hasTripPermission('file_edit', tripId, userId)) return permissionDenied();
        if (reservation_id == null && place_id == null)
          return textError('Provide a reservation_id or place_id to link.');
        if (!getFileById(file_id, tripId)) return textError('File not found.');
        const refErr = checkTripRefs(tripId, reservation_id, place_id);
        if (refErr) return textError(refErr.error);

        createFileLink(file_id, {
          reservation_id: reservation_id != null ? String(reservation_id) : null,
          place_id: place_id != null ? String(place_id) : null,
        });
        safeBroadcast(tripId, 'file:updated', { file_id });
        return ok({ links: getFileLinks(file_id) });
      },
    );

    server.registerTool(
      'unlink_file',
      {
        description:
          'Remove one additional reservation/place link from a file by its link id (see list_files / link_file output).',
        inputSchema: {
          tripId: z.number().int().positive(),
          file_id: z.number().int().positive(),
          link_id: z.number().int().positive(),
        },
        annotations: TOOL_ANNOTATIONS_WRITE,
      },
      async ({ tripId, file_id, link_id }) => {
        if (isDemoUser(userId)) return demoDenied();
        if (!canAccessTrip(tripId, userId)) return noAccess();
        if (!hasTripPermission('file_edit', tripId, userId)) return permissionDenied();
        if (!getFileById(file_id, tripId)) return textError('File not found.');

        deleteFileLink(link_id, file_id);
        safeBroadcast(tripId, 'file:updated', { file_id });
        return ok({ links: getFileLinks(file_id) });
      },
    );

    server.registerTool(
      'update_file',
      {
        description: "Update a file's description or primary reservation/place assignment.",
        inputSchema: {
          tripId: z.number().int().positive(),
          file_id: z.number().int().positive(),
          description: z.string().max(1000).optional(),
          reservation_id: z
            .number()
            .int()
            .positive()
            .nullable()
            .optional()
            .describe('Set the primary reservation, or null to clear it'),
          place_id: z
            .number()
            .int()
            .positive()
            .nullable()
            .optional()
            .describe('Set the primary place, or null to clear it'),
        },
        annotations: TOOL_ANNOTATIONS_WRITE,
      },
      async ({ tripId, file_id, description, reservation_id, place_id }) => {
        if (isDemoUser(userId)) return demoDenied();
        if (!canAccessTrip(tripId, userId)) return noAccess();
        if (!hasTripPermission('file_edit', tripId, userId)) return permissionDenied();
        const current = getFileById(file_id, tripId);
        if (!current) return textError('File not found.');
        const refErr = checkTripRefs(tripId, reservation_id ?? undefined, place_id ?? undefined);
        if (refErr) return textError(refErr.error);

        const file = updateFile(file_id, current, {
          description,
          reservation_id:
            reservation_id === undefined ? undefined : reservation_id === null ? null : String(reservation_id),
          place_id: place_id === undefined ? undefined : place_id === null ? null : String(place_id),
        });
        safeBroadcast(tripId, 'file:updated', { file });
        return ok({ file });
      },
    );
  }

  if (mayDelete) {
    server.registerTool(
      'delete_file',
      {
        description: 'Soft-delete a file (moves it to the trip trash; it can be restored from the web app).',
        inputSchema: {
          tripId: z.number().int().positive(),
          file_id: z.number().int().positive(),
        },
        annotations: TOOL_ANNOTATIONS_DELETE,
      },
      async ({ tripId, file_id }) => {
        if (isDemoUser(userId)) return demoDenied();
        if (!canAccessTrip(tripId, userId)) return noAccess();
        if (!hasTripPermission('file_delete', tripId, userId)) return permissionDenied();
        if (!getFileById(file_id, tripId)) return textError('File not found.');

        softDeleteFile(file_id);
        safeBroadcast(tripId, 'file:deleted', { file_id });
        return ok({ success: true });
      },
    );
  }
}
