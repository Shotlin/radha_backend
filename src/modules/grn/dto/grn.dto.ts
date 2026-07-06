import { z } from 'zod';

/**
 * BE-26 — Consolidated GRN DTOs.
 *
 * Single file mirrors the BE-15..BE-19 convention. Every schema
 * exports both `XxxSchema` and `XxxDto = z.infer<typeof XxxSchema>`.
 *
 * Caps on every list field keep request bodies bounded: a GRN is a
 * manager workflow, not a data pipeline, so 200 lines max is plenty
 * for any real invoice and stops accidental denial-of-service.
 */

const GRN_STATUSES = ['draft', 'pending_review', 'posted', 'cancelled', 'reversed'] as const;

/* ─────────────────── Item ─────────────────── */

export const GrnItemSchema = z
  .object({
    productId: z.string().uuid().optional(),
    /** EAN-8 / EAN-13 / UPC-A — accepted in 8..13 digit range. */
    ean: z.string().regex(/^\d{8,13}$/, 'EAN must be 8–13 digits'),
    productName: z.string().trim().min(1).max(200).optional(),
    quantity: z.coerce
      .number()
      .int('quantity must be an integer')
      .positive('quantity must be > 0')
      .max(1_000_000),
    unit: z.string().max(20).default('pcs'),

    batchNumber: z.string().trim().max(100).optional(),
    manufactureDate: z.coerce.date().optional(),
    expiryDate: z.coerce.date().optional(),

    unitPrice: z.coerce.number().nonnegative().max(1_000_000_000).optional(),
    taxPercent: z.coerce.number().min(0).max(100).optional(),

    notes: z.string().max(500).optional(),
  })
  .refine((d) => !d.expiryDate || !d.manufactureDate || d.expiryDate > d.manufactureDate, {
    message: 'expiryDate must be after manufactureDate',
    path: ['expiryDate'],
  });
export type GrnItemDto = z.infer<typeof GrnItemSchema>;

export const UpdateGrnItemSchema = z
  .object({
    productId: z.string().uuid().optional(),
    productName: z.string().trim().min(1).max(200).optional(),
    quantity: z.coerce.number().int().positive().max(1_000_000).optional(),
    unit: z.string().max(20).optional(),
    batchNumber: z.string().trim().max(100).optional(),
    manufactureDate: z.coerce.date().optional(),
    expiryDate: z.coerce.date().optional(),
    unitPrice: z.coerce.number().nonnegative().optional(),
    taxPercent: z.coerce.number().min(0).max(100).optional(),
    notes: z.string().max(500).optional(),
  })
  .refine((d) => !d.expiryDate || !d.manufactureDate || d.expiryDate > d.manufactureDate, {
    message: 'expiryDate must be after manufactureDate',
    path: ['expiryDate'],
  });
export type UpdateGrnItemDto = z.infer<typeof UpdateGrnItemSchema>;

export const AddItemsSchema = z.object({
  items: z.array(GrnItemSchema).min(1).max(200),
});
export type AddItemsDto = z.infer<typeof AddItemsSchema>;

/* ─────────────────── Header create / update ─────────────────── */

export const CreateGrnSchema = z
  .object({
    supplierId: z.string().uuid(),
    storeId: z.string().uuid(),
    invoiceNumber: z.string().trim().min(1).max(100),
    invoiceDate: z.coerce.date(),
    inwardDate: z.coerce.date(),

    poNumber: z.string().trim().max(100).optional(),
    expectedDeliveryDate: z.coerce.date().optional(),
    orderDate: z.coerce.date().optional(),

    subtotal: z.coerce.number().nonnegative().optional(),
    taxAmount: z.coerce.number().nonnegative().optional(),
    totalAmount: z.coerce.number().nonnegative().optional(),

    items: z.array(GrnItemSchema).max(200).optional(),

    notes: z.string().max(2000).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((d) => !d.orderDate || d.inwardDate.getTime() >= d.orderDate.getTime(), {
    message: 'inwardDate must be on or after orderDate',
    path: ['inwardDate'],
  });
export type CreateGrnDto = z.infer<typeof CreateGrnSchema>;

export const UpdateGrnSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(100).optional(),
  invoiceDate: z.coerce.date().optional(),
  poNumber: z.string().trim().max(100).optional(),
  inwardDate: z.coerce.date().optional(),
  expectedDeliveryDate: z.coerce.date().optional(),
  orderDate: z.coerce.date().optional(),
  subtotal: z.coerce.number().nonnegative().optional(),
  taxAmount: z.coerce.number().nonnegative().optional(),
  totalAmount: z.coerce.number().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateGrnDto = z.infer<typeof UpdateGrnSchema>;

/* ─────────────────── Workflow actions ─────────────────── */

/** Posting takes no body (action only); kept as a schema so the
 * controller pipe stays consistent. */
export const PostGrnSchema = z.object({});
export type PostGrnDto = z.infer<typeof PostGrnSchema>;

export const CancelGrnSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type CancelGrnDto = z.infer<typeof CancelGrnSchema>;

export const ReverseGrnSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type ReverseGrnDto = z.infer<typeof ReverseGrnSchema>;

/* ─────────────────── Listing / queries ─────────────────── */

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

export const ListGrnsQuerySchema = z.object({
  storeId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  status: csvEnum(GRN_STATUSES),
  invoiceNumber: z.string().trim().max(100).optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListGrnsQueryDto = z.infer<typeof ListGrnsQuerySchema>;

export const GrnStatsQuerySchema = z.object({
  storeId: z.string().uuid().optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
});
export type GrnStatsQueryDto = z.infer<typeof GrnStatsQuerySchema>;
