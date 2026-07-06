import { z } from 'zod';

const SCAN_SESSION_TYPES = [
  'audit',
  'shelf-check',
  'expiry-check',
  'inventory',
  'training',
  'general',
] as const;

const SCAN_SESSION_STATUSES = ['active', 'completed', 'abandoned', 'expired'] as const;

/* ─────────────────── Sessions ─────────────────── */

export const CreateSessionSchema = z.object({
  storeId: z.string().uuid(),
  type: z.enum(SCAN_SESSION_TYPES).default('general'),
  taskId: z.string().uuid().optional(),
  eanListId: z.string().uuid().optional(),
  startLatitude: z.number().min(-90).max(90).optional(),
  startLongitude: z.number().min(-180).max(180).optional(),
  deviceId: z.string().max(255).optional(),
  deviceModel: z.string().max(100).optional(),
  appVersion: z.string().max(32).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateSessionDto = z.infer<typeof CreateSessionSchema>;

export const EndSessionSchema = z.object({
  notes: z.string().max(500).optional(),
});
export type EndSessionDto = z.infer<typeof EndSessionSchema>;

export const ListSessionsQuerySchema = z.object({
  storeId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  status: z.enum(SCAN_SESSION_STATUSES).optional(),
  type: z.enum(SCAN_SESSION_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type ListSessionsQueryDto = z.infer<typeof ListSessionsQuerySchema>;

/* ─────────────────── Items ─────────────────── */

export const ScanItemSchema = z
  .object({
    /**
     * BE-17 — Mobile-generated UUID. Together with `sessionId` it
     * idempotently identifies the scan across offline-sync replays.
     * Optional on the single-scan `POST /:id/items` route (so older
     * Mobile_App builds keep working); required for bulk sync where
     * idempotency is the entire point.
     */
    clientId: z.string().uuid().optional(),
    ean: z
      .string()
      .min(6)
      .max(20)
      .regex(/^[\d\s-]+$/, 'EAN must contain only digits, spaces, dashes'),
    scannedAt: z.coerce.date(),
    productId: z.string().uuid().optional(),
    expiryDate: z.coerce.date().optional(),
    manufactureDate: z.coerce.date().optional(),
    batchNumber: z.string().max(100).optional(),
    quantity: z.coerce.number().int().min(1).max(100_000).default(1),
    shelfLocation: z.string().max(100).optional(),
    notes: z.string().max(500).optional(),
    imageMediaId: z.string().uuid().optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    deviceId: z.string().max(255).optional(),
  })
  .refine(
    (d) =>
      !d.expiryDate || !d.manufactureDate || d.expiryDate.getTime() > d.manufactureDate.getTime(),
    { message: 'Expiry date must be after manufacture date', path: ['expiryDate'] },
  );
export type ScanItemDto = z.infer<typeof ScanItemSchema>;

export const ScanBatchSchema = z.object({
  items: z.array(ScanItemSchema).min(1).max(200),
});
export type ScanBatchDto = z.infer<typeof ScanBatchSchema>;

export const ListItemsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type ListItemsQueryDto = z.infer<typeof ListItemsQuerySchema>;
