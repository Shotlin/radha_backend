import { z } from 'zod';

/** `POST /products/{ean}/batches/{batchCode}/observations` body. */
export const CreateObservationSchema = z
  .object({
    expiryDate: z.coerce.date(),
    mfgDate: z.coerce.date().optional(),
    capturedVia: z.enum(['live_scan', 'manual']),
    extractorConfidence: z.coerce.number().min(0).max(1).optional(),
  })
  .strict();
export type CreateObservationDto = z.infer<typeof CreateObservationSchema>;
