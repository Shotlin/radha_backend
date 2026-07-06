import { z } from 'zod';

/**
 * BE-55 — `POST /api/v1/shopping-lists` request body.
 *
 * The list `name` is optional — the database default is
 * "My Shopping List", which is the sensible fallback for users who
 * just want a single ad-hoc list.
 */
export const CreateShoppingListSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'name must not be blank')
      .max(120, 'name is too long')
      .optional(),
  })
  .strict();

export type CreateShoppingListDto = z.infer<typeof CreateShoppingListSchema>;

/**
 * Request body for `PATCH /api/v1/shopping-lists/:id`.
 *
 * Both fields are optional but at least one must be present. `archived`
 * accepts `true` to archive and `false` to unarchive, so a fat-fingered
 * archive can be reverted from the same surface.
 */
export const UpdateShoppingListSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.archived !== undefined, {
    message: 'Provide name or archived',
  });

export type UpdateShoppingListDto = z.infer<typeof UpdateShoppingListSchema>;
