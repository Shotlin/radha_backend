import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { z } from 'zod';

/**
 * BE-28 v2 — Checkout DTO.
 *
 * Mobile clients hit `POST /api/v1/payments/checkout` with the plan
 * they want to buy. The backend creates a Razorpay order and hands
 * back the prefill payload so the Flutter app can open native
 * checkout (`razorpay_flutter`).
 *
 * `packType` distinguishes a recurring monthly purchase from a one-time
 * 24-hour access pass. It's a one-time Razorpay Order either way (this
 * backend never calls Razorpay's Subscriptions API) — `packType` only
 * changes which price is charged and how long the resulting access lasts.
 * Defaults to `'monthly'` so existing mobile clients that don't send it
 * keep working unchanged.
 */
export class CheckoutDto {
  @IsUUID('4', { message: 'planId must be a valid UUID' })
  planId!: string;

  @IsString()
  @IsIn(['monthly', 'yearly'], { message: "billingCycle must be 'monthly' or 'yearly'" })
  billingCycle!: 'monthly' | 'yearly';

  @IsOptional()
  @IsString()
  @IsIn(['monthly', 'day_pass'], { message: "packType must be 'monthly' or 'day_pass'" })
  packType?: 'monthly' | 'day_pass';
}

export const CheckoutSchema = z.object({
  planId: z.string().uuid({ message: 'planId must be a valid UUID' }),
  billingCycle: z.enum(['monthly', 'yearly'], {
    errorMap: () => ({ message: "billingCycle must be 'monthly' or 'yearly'" }),
  }),
  packType: z
    .enum(['monthly', 'day_pass'], {
      errorMap: () => ({ message: "packType must be 'monthly' or 'day_pass'" }),
    })
    .optional()
    .default('monthly'),
});

export type CheckoutInput = z.infer<typeof CheckoutSchema>;

export interface CheckoutResult {
  razorpayOrderId: string;
  keyId: string;
  amountPaise: number;
  currency: 'INR';
  prefill: {
    name: string;
    email: string;
    contact: string;
  };
  notes: Record<string, string | number | boolean>;
}
