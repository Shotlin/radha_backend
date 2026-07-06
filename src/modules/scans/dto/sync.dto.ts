import { z } from 'zod';

/**
 * BE-17 — Bulk-sync DTOs.
 *
 * `BulkScanItemSchema` is a stricter variant of the BE-16 single-scan
 * DTO: `clientId` is **required** because it's the entire idempotency
 * contract. Mobile_App generates UUIDs locally and replays them on
 * sync retries.
 */

export const BulkScanItemSchema = z
  .object({
    clientId: z.string().uuid(),
    ean: z
      .string()
      .min(6)
      .max(20)
      .regex(/^[\d\s-]+$/, 'EAN must contain only digits, spaces, dashes'),
    scannedAt: z.coerce.date(),
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
export type BulkScanItemDto = z.infer<typeof BulkScanItemSchema>;

export const BulkSyncMetadataSchema = z.object({
  deviceId: z.string().max(255).optional(),
  appVersion: z.string().max(32).optional(),
  syncedAt: z.coerce.date().optional(),
  offlineDurationSeconds: z.coerce.number().int().nonnegative().optional(),
});
export type BulkSyncMetadataDto = z.infer<typeof BulkSyncMetadataSchema>;

export const BulkSyncSchema = z.object({
  items: z.array(BulkScanItemSchema).min(1).max(5000),
  metadata: BulkSyncMetadataSchema.optional(),
});
export type BulkSyncDto = z.infer<typeof BulkSyncSchema>;

export const ListSyncBatchesQuerySchema = z.object({
  sessionId: z.string().uuid().optional(),
  status: z
    .enum(['queued', 'processing', 'completed', 'failed', 'cancelled', 'partial'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListSyncBatchesQueryDto = z.infer<typeof ListSyncBatchesQuerySchema>;
