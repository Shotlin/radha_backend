import { z } from 'zod';

export const VerifyOtpSchema = z.object({
  mobile: z.string().min(10).max(20),
  otp: z.string().regex(/^\d{4,8}$/, 'OTP must be 4–8 digits'),
  requestId: z.string().uuid('requestId must be a UUID'),
  deviceId: z.string().min(1).max(255).optional(),
});

export type VerifyOtpDto = z.infer<typeof VerifyOtpSchema>;
