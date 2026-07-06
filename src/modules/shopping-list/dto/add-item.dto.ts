import { z } from 'zod';

/**
 * BE-55 — `POST /api/v1/shopping-lists/:id/items` request body.
 *
 * Only `item` is required (the line text). `quantity` and `notes`
 * stay free-form text since the v1 spec is text-only — no
 * normalisation, no unit catalogue. `position` lets the client pin
 * the new item to a specific slot; when omitted the service appends
 * to the end of the list.
 */
export const AddShoppingListItemSchema = z
  .object({
    item: z.string().trim().min(1, 'item must not be blank').max(200, 'item is too long'),
    quantity: z.string().trim().min(1).max(50).optional(),
    notes: z.string().trim().max(500).optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict();

export type AddShoppingListItemDto = z.infer<typeof AddShoppingListItemSchema>;

/**
 * Request body for `PATCH /api/v1/shopping-lists/:id/items/:itemId`.
 *
 * Lets the client toggle `isPurchased`, edit the line text/quantity/
 * notes, or reorder via `position`. Every field is optional but at
 * least one must be provided.
 */
export const UpdateShoppingListItemSchema = z
  .object({
    item: z.string().trim().min(1).max(200).optional(),
    quantity: z.string().trim().min(1).max(50).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    isPurchased: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.item !== undefined ||
      value.quantity !== undefined ||
      value.notes !== undefined ||
      value.isPurchased !== undefined ||
      value.position !== undefined,
    { message: 'At least one field must be provided' },
  );

export type UpdateShoppingListItemDto = z.infer<typeof UpdateShoppingListItemSchema>;
