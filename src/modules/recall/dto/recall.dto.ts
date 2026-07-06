import { z } from 'zod';

/**
 * BE-39 — Request/response DTOs for the recall HTTP surface.
 *
 * Schemas are validated through `ZodValidationPipe`. The exported
 * types are inferred from the schemas so the controller and the
 * Mobile_App can rely on a single source of truth.
 */

export const ListRecallAlertsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(512).optional(),
    unacknowledgedOnly: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .transform((v) => (typeof v === 'string' ? v === 'true' : (v ?? false))),
  })
  .strict();

export type ListRecallAlertsQueryDto = z.infer<typeof ListRecallAlertsQuerySchema>;

export const AcknowledgeRecallAlertParamSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export type AcknowledgeRecallAlertParamDto = z.infer<typeof AcknowledgeRecallAlertParamSchema>;

export interface RecallAlertResponseDto {
  id: string;
  acknowledgedAt: string | null;
  createdAt: string;
  savedProductId: string | null;
  feedEntry: {
    id: string;
    source: string;
    ean: string | null;
    brand: string | null;
    productName: string | null;
    batchNumber: string | null;
    reason: string;
    recalledAt: string;
  };
}

export interface RecallAlertListResponseDto {
  data: RecallAlertResponseDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AcknowledgeRecallAlertResponseDto {
  id: string;
  acknowledgedAt: string;
}
