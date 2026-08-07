import { z } from 'zod';

export const LegacyLinkVerifySchema = z.object({
  mobile: z.string().min(10).max(20),
  otp: z.string().regex(/^\d{4,8}$/, 'OTP must be 4–8 digits'),
  requestId: z.string().uuid('requestId must be a UUID'),
  idToken: z.string().min(1),
  deviceId: z.string().min(1).max(255).optional(),
});

export type LegacyLinkVerifyDto = z.infer<typeof LegacyLinkVerifySchema>;
