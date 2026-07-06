import { z } from 'zod';

export const NutritionInputSchema = z.object({
  servingSize: z.coerce.number().positive().optional(),
  servingUnit: z.enum(['g', 'ml']).optional(),
  calories: z.coerce.number().nonnegative().optional(),
  protein: z.coerce.number().nonnegative().optional(),
  carbohydrates: z.coerce.number().nonnegative().optional(),
  sugars: z.coerce.number().nonnegative().optional(),
  fat: z.coerce.number().nonnegative().optional(),
  saturatedFat: z.coerce.number().nonnegative().optional(),
  fiber: z.coerce.number().nonnegative().optional(),
  sodium: z.coerce.number().nonnegative().optional(),
  isProcessed: z.enum(['not', 'lightly', 'ultra']).optional(),
  containsAllergens: z.array(z.string().min(1).max(64)).max(20).optional(),
});
export type NutritionInputDto = z.infer<typeof NutritionInputSchema>;

export const CreateProductSchema = z.object({
  ean: z
    .string()
    .min(6)
    .max(20)
    .regex(/^[\d\s-]+$/, 'EAN must contain only digits, spaces, and dashes'),
  name: z.string().min(1).max(200),
  brand: z.string().max(100).optional(),
  manufacturer: z.string().max(200).optional(),
  categoryId: z.string().uuid().optional(),
  subCategory: z.string().max(100).optional(),
  productType: z.string().max(50).optional(),
  imageUrl: z.string().url().max(500).optional(),
  description: z.string().max(2000).optional(),
  packageSize: z.string().max(50).optional(),
  packageUnit: z.enum(['g', 'kg', 'ml', 'l', 'pcs', 'pack']).optional(),
  packageType: z.string().max(50).optional(),
  nutrition: NutritionInputSchema.optional(),
});
export type CreateProductDto = z.infer<typeof CreateProductSchema>;

export const UpdateProductSchema = CreateProductSchema.partial().extend({
  status: z.enum(['active', 'discontinued', 'pending_review', 'rejected']).optional(),
  isVerified: z.coerce.boolean().optional(),
});
export type UpdateProductDto = z.infer<typeof UpdateProductSchema>;

export const ProductLookupBatchSchema = z.object({
  eans: z.array(z.string().min(6).max(20)).min(1).max(50),
});
export type ProductLookupBatchDto = z.infer<typeof ProductLookupBatchSchema>;

export const ScanModeToggleSchema = z.object({
  mode: z.enum(['basic', 'comprehensive']),
});
export type ScanModeToggleDto = z.infer<typeof ScanModeToggleSchema>;

export const ProductSearchQuerySchema = z.object({
  q: z.string().min(1).max(100).optional(),
  category: z.string().uuid().optional(),
  brand: z.string().max(100).optional(),
  status: z.enum(['active', 'discontinued', 'pending_review', 'rejected']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  orderBy: z.enum(['name', 'createdAt', 'updatedAt']).default('createdAt'),
  orderDirection: z.enum(['asc', 'desc']).default('desc'),
});
export type ProductSearchQueryDto = z.infer<typeof ProductSearchQuerySchema>;
