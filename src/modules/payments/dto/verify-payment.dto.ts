import { IsString, MinLength } from 'class-validator';
import { z } from 'zod';

/**
 * BE-28 v2 — Razorpay verification DTO.
 *
 * After native checkout completes, the mobile app posts the three
 * Razorpay-supplied fields back to the server. The service verifies
 * `razorpaySignature` against an HMAC-SHA256 of
 * `${orderId}|${paymentId}` keyed on the merchant secret and, on
 * success, marks the order captured + activates the subscription.
 */
export class VerifyPaymentDto {
  @IsString()
  @MinLength(8)
  razorpayOrderId!: string;

  @IsString()
  @MinLength(8)
  razorpayPaymentId!: string;

  @IsString()
  @MinLength(8)
  razorpaySignature!: string;
}

export const VerifyPaymentSchema = z.object({
  razorpayOrderId: z.string().min(8),
  razorpayPaymentId: z.string().min(8),
  razorpaySignature: z.string().min(8),
});

export type VerifyPaymentInputDto = z.infer<typeof VerifyPaymentSchema>;

export interface VerifyPaymentResult {
  ok: boolean;
  razorpayOrderId: string;
  status: string;
  subscription?: { tenantId: string; planCode: string };
}
