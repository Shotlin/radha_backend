import { z } from 'zod';

const EXPIRY_STATUSES = ['green', 'yellow', 'red', 'expired', 'unknown'] as const;
const ALERT_RESOLUTIONS = [
  'discounted',
  'sold',
  'removed',
  'returned',
  'donated',
  'discarded',
] as const;

/* ─────────────────── Records ─────────────────── */

export const CreateExpiryRecordSchema = z
  .object({
    productId: z.string().uuid(),
    storeId: z.string().uuid(),
    expiryDate: z.coerce.date(),
    manufactureDate: z.coerce.date().optional(),
    batchNumber: z.string().max(100).optional(),
    quantity: z.coerce.number().int().min(1).max(100_000).default(1),
    source: z.enum(['scan', 'grn', 'manual', 'ocr']).default('manual'),
    sourceId: z.string().uuid().optional(),
    shelfLocation: z.string().max(100).optional(),
    notes: z.string().max(500).optional(),
  })
  .refine((d) => !d.manufactureDate || d.expiryDate.getTime() > d.manufactureDate.getTime(), {
    message: 'Expiry must be after manufacture date',
    path: ['expiryDate'],
  });
export type CreateExpiryRecordDto = z.infer<typeof CreateExpiryRecordSchema>;

export const ListExpiryRecordsQuerySchema = z.object({
  storeId: z.string().uuid(),
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const arr = Array.isArray(v) ? v : v.split(',');
      const cleaned = arr
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is (typeof EXPIRY_STATUSES)[number] =>
          (EXPIRY_STATUSES as readonly string[]).includes(s),
        );
      return cleaned.length > 0 ? cleaned : undefined;
    }),
  productId: z.string().uuid().optional(),
  category: z.string().max(100).optional(),
  daysAhead: z.coerce.number().int().min(0).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListExpiryRecordsQueryDto = z.infer<typeof ListExpiryRecordsQuerySchema>;

export const NearExpiryQuerySchema = z.object({
  storeId: z.string().uuid(),
  daysAhead: z.coerce.number().int().min(1).max(365).default(30),
});
export type NearExpiryQueryDto = z.infer<typeof NearExpiryQuerySchema>;

export const ExpiryStatsQuerySchema = z.object({
  storeId: z.string().uuid(),
});
export type ExpiryStatsQueryDto = z.infer<typeof ExpiryStatsQuerySchema>;

export const ForecastQuerySchema = z.object({
  storeId: z.string().uuid(),
  daysAhead: z.coerce.number().int().min(1).max(365).default(30),
});
export type ForecastQueryDto = z.infer<typeof ForecastQuerySchema>;

/* ─────────────────── Thresholds ─────────────────── */

export const SetThresholdSchema = z
  .object({
    category: z.string().min(1).max(100),
    yellowDays: z.coerce.number().int().min(1).max(3650),
    redDays: z.coerce.number().int().min(0).max(3650),
  })
  .refine((d) => d.yellowDays > d.redDays, {
    message: 'yellowDays must be greater than redDays',
    path: ['yellowDays'],
  });
export type SetThresholdDto = z.infer<typeof SetThresholdSchema>;

export const ListThresholdsQuerySchema = z.object({
  category: z.string().max(100).optional(),
});
export type ListThresholdsQueryDto = z.infer<typeof ListThresholdsQuerySchema>;

/* ─────────────────── Alerts ─────────────────── */

export const ListAlertsQuerySchema = z.object({
  storeId: z.string().uuid(),
  acknowledged: z.coerce.boolean().optional(),
  resolved: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListAlertsQueryDto = z.infer<typeof ListAlertsQuerySchema>;

export const AcknowledgeAlertSchema = z.object({
  notes: z.string().max(500).optional(),
});
export type AcknowledgeAlertDto = z.infer<typeof AcknowledgeAlertSchema>;

export const ResolveAlertSchema = z.object({
  resolution: z.enum(ALERT_RESOLUTIONS),
  notes: z.string().max(500).optional(),
});
export type ResolveAlertDto = z.infer<typeof ResolveAlertSchema>;

/* ─────────────────── Recalculate ─────────────────── */

export const RecalculateBodySchema = z.object({
  storeId: z.string().uuid(),
});
export type RecalculateBodyDto = z.infer<typeof RecalculateBodySchema>;

/* ─────────────────── OCR ─────────────────── */

export const OcrValidateBodySchema = z.object({
  text: z.string().min(1).max(500),
  confidence: z.coerce.number().min(0).max(1).default(1),
});
export type OcrValidateBodyDto = z.infer<typeof OcrValidateBodySchema>;
