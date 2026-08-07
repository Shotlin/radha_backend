import { z } from 'zod';

export const FirebaseExchangeSchema = z.object({
  idToken: z.string().min(1),
  deviceId: z.string().min(1).max(255).optional(),
});

export type FirebaseExchangeDto = z.infer<typeof FirebaseExchangeSchema>;
