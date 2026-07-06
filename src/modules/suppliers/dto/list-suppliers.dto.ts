import { z } from 'zod';

/**
 * BE-25 — list / search query DTO.
 *
 * Cursor pagination on `(name asc, id asc)` to give a stable list
 * order for managers. Free-text `q` matches `name`, `code`,
 * `legalName`, and `gstNumber` (ILIKE). `status` accepts a
 * comma-separated list so the front-end can request multiple
 * statuses in one round trip.
 */

const STATUSES = ['active', 'inactive', 'blacklisted', 'pending'] as const;

const csvEnum = <T extends readonly string[]>(allowed: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const arr = Array.isArray(v) ? v : v.split(',');
      const cleaned = arr
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is T[number] => (allowed as readonly string[]).includes(s));
      return cleaned.length > 0 ? (cleaned as T[number][]) : undefined;
    });

export const ListSuppliersSchema = z.object({
  q: z.string().max(200).optional(),
  status: csvEnum(STATUSES),
  category: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListSuppliersDto = z.infer<typeof ListSuppliersSchema>;

export const ExportSuppliersSchema = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
});
export type ExportSuppliersDto = z.infer<typeof ExportSuppliersSchema>;
