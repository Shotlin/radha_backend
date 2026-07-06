import { z } from 'zod';

/* ─────────────────── List CRUD ─────────────────── */

export const CreateEanListSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  storeId: z.string().uuid().optional(),
});
export type CreateEanListDto = z.infer<typeof CreateEanListSchema>;

export const UpdateEanListSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
});
export type UpdateEanListDto = z.infer<typeof UpdateEanListSchema>;

export const ListEanListsQuerySchema = z.object({
  storeId: z.string().uuid().optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type ListEanListsQueryDto = z.infer<typeof ListEanListsQuerySchema>;

/* ─────────────────── Import ─────────────────── */

export const InitiateImportSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileType: z.enum(['xlsx', 'csv']),
  fileSize: z.coerce
    .number()
    .int()
    .min(100)
    .max(20 * 1024 * 1024), // 20 MB max
});
export type InitiateImportDto = z.infer<typeof InitiateImportSchema>;

export const ImportInlineSchema = z.object({
  fileType: z.enum(['xlsx', 'csv']),
  fileName: z.string().min(1).max(255),
  /** Base64-encoded file body. Caps at ~13.3 MB raw / 10 MB binary after b64 overhead. */
  fileBase64: z.string().min(1).max(14_000_000),
});
export type ImportInlineDto = z.infer<typeof ImportInlineSchema>;

export const ImportFromS3Schema = z.object({
  s3Key: z.string().min(1).max(500),
  fileName: z.string().min(1).max(255),
  fileType: z.enum(['xlsx', 'csv']),
});
export type ImportFromS3Dto = z.infer<typeof ImportFromS3Schema>;

/* ─────────────────── Validation ─────────────────── */

export const ValidateEanSchema = z.object({
  ean: z.string().regex(/^[\d\s-]{6,20}$/, 'EAN must be 6–20 digits / spaces / dashes'),
  storeId: z.string().uuid(),
});
export type ValidateEanDto = z.infer<typeof ValidateEanSchema>;

export const ValidateBatchSchema = z.object({
  eans: z.array(z.string()).min(1).max(500),
  storeId: z.string().uuid(),
});
export type ValidateBatchDto = z.infer<typeof ValidateBatchSchema>;

/* ─────────────────── Items query ─────────────────── */

export const SearchItemsSchema = z.object({
  q: z.string().max(80).optional(),
  matched: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type SearchItemsDto = z.infer<typeof SearchItemsSchema>;

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type PaginationQueryDto = z.infer<typeof PaginationQuerySchema>;
