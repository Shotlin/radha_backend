import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Ip,
  Post,
  Req,
  UseGuards,
  Version,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  CurrentTenant,
  CurrentUser,
  Public,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';

import { CheckoutSchema, type CheckoutInput, type CheckoutResult } from './dto/checkout.dto';
import { RefundSchema, type RefundInputDto, type RefundResult } from './dto/refund.dto';
import {
  VerifyPaymentSchema,
  type VerifyPaymentInputDto,
  type VerifyPaymentResult,
} from './dto/verify-payment.dto';
import type { WebhookProcessResult } from './dto/webhook-payload.dto';
import { PaymentsService } from './payments.service';

/**
 * BE-28 v2 — Payments REST surface (`/api/v1/payments/*`).
 *
 * Endpoint table:
 *   POST /checkout                  Bearer        Create Razorpay order
 *   POST /verify                    Bearer        HMAC-verify capture
 *   POST /refund                    Bearer+admin  Issue refund
 *   POST /webhooks/razorpay         Public+HMAC   Inbound provider webhook
 *
 * Transport-only — all business logic lives in `PaymentsService`.
 * The webhook route reads the raw body so HMAC verification is
 * computed against the unparsed payload.
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Post('checkout')
  @Version('1')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  checkout(
    @Body(new ZodValidationPipe(CheckoutSchema)) dto: CheckoutInput,
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string | null,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<CheckoutResult> {
    return this.service.createCheckout(dto, { userId, tenantId, ip, userAgent });
  }

  @Post('verify')
  @Version('1')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  verify(
    @Body(new ZodValidationPipe(VerifyPaymentSchema)) dto: VerifyPaymentInputDto,
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string | null,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<VerifyPaymentResult> {
    return this.service.verifyPayment(dto, { userId, tenantId, ip, userAgent });
  }

  @Post('refund')
  @Version('1')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'owner')
  refund(
    @Body(new ZodValidationPipe(RefundSchema)) dto: RefundInputDto,
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string | null,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<RefundResult> {
    return this.service.refundPayment(dto, { userId, tenantId, ip, userAgent });
  }

  /**
   * Razorpay webhook receiver.
   *
   *   - Public route (no JWT) — Razorpay's servers can't carry one.
   *   - HMAC-SHA256 of the **raw** body must equal
   *     `X-Razorpay-Signature`.
   *   - Inserts into `payment_webhooks_inbox` (unique on `event_id`)
   *     and short-circuits with `{ duplicate: true }` on retry.
   *   - Always returns 200 once the signature is valid; handler
   *     errors are recorded into `processing_error` and replayed
   *     by an out-of-band job rather than triggering Razorpay
   *     retries on a deterministic failure.
   */
  @Post('webhooks/razorpay')
  @Version('1')
  @Public()
  @HttpCode(200)
  async razorpayWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
  ): Promise<WebhookProcessResult> {
    const rawBody = this.readRawBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new BadRequestException({
        code: 'PAYMENT_WEBHOOK_BODY_INVALID',
        message: 'Webhook body is not valid JSON',
      });
    }
    return this.service.handleWebhook(rawBody, signature ?? '', parsed);
  }

  private readRawBody(req: RawBodyRequest<Request>): string {
    if (req.rawBody && req.rawBody.length > 0) {
      return req.rawBody.toString('utf8');
    }
    throw new BadRequestException({
      code: 'PAYMENT_WEBHOOK_BODY_MISSING',
      message: 'Empty webhook body',
    });
  }
}
