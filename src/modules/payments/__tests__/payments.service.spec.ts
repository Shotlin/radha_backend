import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { RazorpayMockProvider } from '@/integrations/razorpay/providers/razorpay-mock.provider';
import { RazorpayService } from '@/integrations/razorpay/razorpay.service';

import type { VerifyPaymentInputDto } from '../dto/verify-payment.dto';
import { PaymentsService } from '../payments.service';

/**
 * BE-28 v2 — Verify-signature semantics.
 *
 * Two locked-down behaviours:
 *   1. Happy path — a valid HMAC-SHA256 signature flips the order
 *      to `captured`, audits the transition, and returns `ok: true`.
 *   2. Tampered signature — the service marks the order `failed`,
 *      audits the failure, and throws `BusinessException(PAYMENT_PROVIDER_ERROR)`.
 *
 * Dependencies are stubbed manually instead of via Nest's `Test`
 * harness because we only exercise a single method — keeps the
 * test under 80 lines and free of `@nestjs/testing` boot overhead.
 */
describe('PaymentsService.verifyPayment', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const userId = '00000000-0000-4000-8000-000000000002';
  const planId = '00000000-0000-4000-8000-000000000003';

  const mock = new RazorpayMockProvider();
  // The live constructor is bypassed because `config.payments.isLive`
  // returns false on the stub config — the service therefore wires
  // straight to the mock provider.
  const config = {
    payments: { keyId: '', keySecret: '', webhookSecret: '', isLive: false },
  } as never;
  const razorpayService = new RazorpayService(config, mock);

  const buildSubject = (): {
    service: PaymentsService;
    repo: {
      findOrderForActor: jest.Mock;
      updateOrderStatus: jest.Mock;
    };
    auditLog: { logAction: jest.Mock };
    subscriptions: { upgradeToPlan: jest.Mock };
  } => {
    const repo = {
      findOrderForActor: jest.fn(),
      updateOrderStatus: jest.fn().mockResolvedValue({ status: 'captured' }),
      findOrderByPaymentId: jest.fn(),
      findOrderByRazorpayId: jest.fn(),
      createOrder: jest.fn(),
      recordInboxEvent: jest.fn(),
      markInboxProcessed: jest.fn(),
    };
    const auditLog = { logAction: jest.fn().mockResolvedValue(undefined) };
    const subscriptions = {
      upgradeToPlan: jest.fn().mockResolvedValue({ planCode: 'pro' }),
    };
    const plansRepo = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: planId, code: 'pro', price: '199', yearlyPrice: null }),
    };
    const users = { findById: jest.fn() };

    const service = new PaymentsService(
      repo as never,
      razorpayService,
      plansRepo as never,
      subscriptions as never,
      users as never,
      auditLog as never,
      config,
    );
    return { service, repo, auditLog, subscriptions };
  };

  it('happy path — valid signature flips the order to captured', async () => {
    const { service, repo, auditLog, subscriptions } = buildSubject();
    repo.findOrderForActor.mockResolvedValue({
      id: 'db-id',
      tenantId,
      planId,
      razorpayOrderId: 'order_mock_abc',
      status: 'created',
    });
    const dto: VerifyPaymentInputDto = {
      razorpayOrderId: 'order_mock_abc',
      razorpayPaymentId: 'pay_xyz_999',
      razorpaySignature: mock.signPayment('order_mock_abc', 'pay_xyz_999'),
    };

    const result = await service.verifyPayment(dto, { userId, tenantId });

    expect(result.ok).toBe(true);
    expect(result.razorpayOrderId).toBe('order_mock_abc');
    expect(repo.updateOrderStatus).toHaveBeenCalledWith(
      'db-id',
      'captured',
      expect.objectContaining({
        razorpayPaymentId: 'pay_xyz_999',
        postedAt: expect.any(Date),
      }),
    );
    expect(subscriptions.upgradeToPlan).toHaveBeenCalledWith(tenantId, 'pro', userId);
    expect(auditLog.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'RazorpayOrder',
        success: true,
      }),
    );
  });

  it('tampered signature is rejected and order is flipped to failed', async () => {
    const { service, repo, auditLog, subscriptions } = buildSubject();
    repo.findOrderForActor.mockResolvedValue({
      id: 'db-id',
      tenantId,
      planId,
      razorpayOrderId: 'order_mock_abc',
      status: 'created',
    });
    const goodSig = mock.signPayment('order_mock_abc', 'pay_xyz_999');
    const tampered = goodSig.slice(0, -2) + (goodSig.endsWith('00') ? 'ff' : '00');

    const dto: VerifyPaymentInputDto = {
      razorpayOrderId: 'order_mock_abc',
      razorpayPaymentId: 'pay_xyz_999',
      razorpaySignature: tampered,
    };

    await expect(service.verifyPayment(dto, { userId, tenantId })).rejects.toMatchObject({
      code: ErrorCode.PAYMENT_PROVIDER_ERROR,
    });

    expect(repo.updateOrderStatus).toHaveBeenCalledWith(
      'db-id',
      'failed',
      expect.objectContaining({ failedAt: expect.any(Date) }),
    );
    expect(subscriptions.upgradeToPlan).not.toHaveBeenCalled();
    expect(auditLog.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: ErrorCode.PAYMENT_PROVIDER_ERROR,
      }),
    );
  });

  it('unknown order id throws DomainNotFoundException', async () => {
    const { service, repo } = buildSubject();
    repo.findOrderForActor.mockResolvedValue(null);
    await expect(
      service.verifyPayment(
        {
          razorpayOrderId: 'order_missing',
          razorpayPaymentId: 'pay_zzz',
          razorpaySignature: 'whatever',
        },
        { userId, tenantId },
      ),
    ).rejects.toBeInstanceOf(BusinessException);
  });
});
