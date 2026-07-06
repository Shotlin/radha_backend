import { z } from 'zod';

/**
 * BE-25 — bulk-import DTO.
 *
 * The file is delivered base64-encoded inside a JSON body — same
 * pattern BE-15 uses for EAN-list inline imports. Caps the body at
 * ~10 MB binary so a single tenant can't blow up the API process
 * with a runaway upload while still leaving plenty of room for
 * realistic supplier sheets (~5 K rows ≈ 1 MB).
 */
export const ImportSuppliersSchema = z.object({
  fileType: z.enum(['xlsx', 'csv']),
  fileName: z.string().min(1).max(255),
  /** Base64-encoded file body. ~13.3 MB raw → ~10 MB binary. */
  fileBase64: z.string().min(1).max(14_000_000),
});
export type ImportSuppliersDto = z.infer<typeof ImportSuppliersSchema>;
