import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { z } from 'zod';

/**
 * BE-28 v2 — Refund DTO.
 *
 * Admin/owner-only. `amountPaise` is optional; omitting it triggers
 * a full refund per Razorpay's API. `reason` is required so the
 * audit log captures justification.
 */
export class RefundDto {
  @IsString()
  @MinLength(8)
  razorpayPaymentId!: string;

  @IsOptional()
  @IsInt({ message: 'amountPaise must be a positive integer' })
  @Min(100, { message: 'amountPaise must be at least 100 (₹1)' })
  amountPaise?: number;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export const RefundSchema = z.object({
  razorpayPaymentId: z.string().min(8),
  amountPaise: z.number().int().min(100).optional(),
  reason: z.string().min(3).max(500),
});

export type RefundInputDto = z.infer<typeof RefundSchema>;

export interface RefundResult {
  ok: boolean;
  razorpayPaymentId: string;
  refundId: string;
  status: string;
  amountPaise: number;
}
