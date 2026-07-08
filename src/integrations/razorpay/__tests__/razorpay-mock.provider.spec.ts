import { RazorpayMockProvider } from '../providers/razorpay-mock.provider';

/**
 * BE-28 v2 — Sanity tests for the deterministic mock provider.
 *
 * These checks lock down the contract that the rest of the
 * payments stack relies on:
 *   - createOrder is deterministic by receipt
 *   - signPayment / verifyPaymentSignature round-trip
 *   - tampered signatures are rejected
 *   - signWebhook / verifyWebhookSignature round-trip
 */
describe('RazorpayMockProvider', () => {
  let provider: RazorpayMockProvider;

  beforeEach(() => {
    provider = new RazorpayMockProvider();
  });

  it('createOrder returns deterministic id for a given receipt', async () => {
    const a = await provider.createOrder({
      amountPaise: 4900,
      currency: 'INR',
      receipt: 'rcpt_abc',
    });
    const b = await provider.createOrder({
      amountPaise: 9900,
      currency: 'INR',
      receipt: 'rcpt_abc',
    });
    expect(a.id).toBe(b.id);
    expect(a.id.startsWith('order_mock_')).toBe(true);
    expect(a.provider).toBe('razorpay-mock');
    expect(a.status).toBe('created');
  });

  it('createOrder returns different ids for different receipts', async () => {
    const a = await provider.createOrder({
      amountPaise: 4900,
      currency: 'INR',
      receipt: 'rcpt_a',
    });
    const b = await provider.createOrder({
      amountPaise: 4900,
      currency: 'INR',
      receipt: 'rcpt_b',
    });
    expect(a.id).not.toBe(b.id);
  });

  it('signPayment + verifyPaymentSignature round-trip succeeds', () => {
    const orderId = 'order_mock_test123';
    const paymentId = 'pay_test_xyz';
    const signature = provider.signPayment(orderId, paymentId);
    const result = provider.verifyPaymentSignature({
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: signature,
    });
    expect(result.valid).toBe(true);
    expect(result.expectedSignature).toBe(signature);
  });

  it('verifyPaymentSignature rejects a tampered signature', () => {
    const orderId = 'order_mock_test123';
    const paymentId = 'pay_test_xyz';
    const good = provider.signPayment(orderId, paymentId);
    const tampered = good.slice(0, -2) + (good.endsWith('00') ? 'ff' : '00');
    const result = provider.verifyPaymentSignature({
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: tampered,
    });
    expect(result.valid).toBe(false);
  });

  it('verifyPaymentSignature rejects when paymentId differs', () => {
    const sig = provider.signPayment('order_x', 'pay_x');
    const result = provider.verifyPaymentSignature({
      razorpayOrderId: 'order_x',
      razorpayPaymentId: 'pay_y',
      razorpaySignature: sig,
    });
    expect(result.valid).toBe(false);
  });

  it('signWebhook + verifyWebhookSignature round-trip succeeds', () => {
    const body = JSON.stringify({ event: 'payment.captured', payload: {} });
    const sig = provider.signWebhook(body);
    expect(provider.verifyWebhookSignature({ rawBody: body, signature: sig })).toBe(true);
  });

  it('verifyWebhookSignature rejects an empty signature', () => {
    const body = JSON.stringify({ event: 'payment.captured' });
    expect(provider.verifyWebhookSignature({ rawBody: body, signature: '' })).toBe(false);
  });

  it('createRefund returns a deterministic mock refund id', async () => {
    const refund = await provider.createRefund({
      paymentId: 'pay_test_xyz',
      amountPaise: 4900,
      reason: 'customer_request',
    });
    expect(refund.provider).toBe('razorpay-mock');
    expect(refund.status).toBe('processed');
    expect(refund.id.startsWith('rfnd_mock_')).toBe(true);
    expect(refund.paymentId).toBe('pay_test_xyz');
  });
});
