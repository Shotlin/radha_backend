import { z } from 'zod';

import { NutritionPanelSchema } from './nutrition-panel.dto';

/**
 * BE-56 — Body of `POST /api/v1/admin/learn/:id/approve`.
 *
 * The moderator can override / fill in any of the `brand / name /
 * category` fields submitted by the consumer (e.g. correcting a
 * typo) before the data is upserted into `Product_Catalog`. All
 * fields are optional — empty body is "approve as-is".
 *
 * `nutrition` (BE-56 v2) lets the moderator correct any value the
 * scanner misread before it goes live; omitted fields fall back to
 * whatever the consumer submitted (see `barcode-learning.service.ts`
 * `approve()`).
 *
 * `notes` lands in `moderation_notes` for the audit trail.
 */
export const ApproveSubmissionSchema = z
  .object({
    brand: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    category: z.string().trim().min(1).max(120).optional(),
    /** BE-56 v3 — moderator-corrected ingredients list. */
    ingredients: z.string().trim().min(1).max(2000).optional(),
    nutrition: NutritionPanelSchema.optional(),
    notes: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type ApproveSubmissionDto = z.infer<typeof ApproveSubmissionSchema>;

/**
 * BE-56 — Body of `POST /api/v1/admin/learn/:id/reject`.
 *
 * `reason` is required so the moderator must explain why; the value
 * is persisted in `moderation_notes` and surfaced to the submitter
 * on their submission history.
 */
export const RejectSubmissionSchema = z
  .object({
    reason: z.string().trim().min(1, 'reason is required').max(500),
  })
  .strict();

export type RejectSubmissionDto = z.infer<typeof RejectSubmissionSchema>;

/**
 * BE-56 — Query params of `GET /api/v1/admin/learn/queue`.
 *
 * `status` defaults to `pending` — moderators usually only want to
 * see items that need a decision. Pass `flagged` to review entries
 * sent back through the re-moderation door.
 */
export const QueueQuerySchema = z
  .object({
    status: z.enum(['pending', 'flagged']).default('pending'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type QueueQueryDto = z.infer<typeof QueueQuerySchema>;
