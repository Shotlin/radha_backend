import { z } from 'zod';

/**
 * BE-56 v2 — nutrition panel shape shared by the consumer submission
 * body and the moderator's approval-time override body. Field names
 * and bounds mirror `product_nutrition` (see `db/schema/products.ts`)
 * so the real `ProductsCatalogPort` adapter can upsert straight
 * across with no translation.
 *
 * Every field is optional — a scan may only pick up a subset of the
 * panel (or none, if the consumer submits text/photo only).
 */
export const NutritionPanelSchema = z
  .object({
    servingSize: z.coerce.number().nonnegative().max(99_999_999).optional(),
    servingUnit: z.string().trim().min(1).max(10).optional(),
    calories: z.coerce.number().nonnegative().max(999_999).optional(),
    protein: z.coerce.number().nonnegative().max(999_999).optional(),
    carbohydrates: z.coerce.number().nonnegative().max(999_999).optional(),
    sugars: z.coerce.number().nonnegative().max(999_999).optional(),
    fat: z.coerce.number().nonnegative().max(999_999).optional(),
    saturatedFat: z.coerce.number().nonnegative().max(999_999).optional(),
    transFat: z.coerce.number().nonnegative().max(999_999).optional(),
    fiber: z.coerce.number().nonnegative().max(999_999).optional(),
    sodium: z.coerce.number().nonnegative().max(999_999).optional(),
  })
  .strict();

export type NutritionPanelDto = z.infer<typeof NutritionPanelSchema>;
