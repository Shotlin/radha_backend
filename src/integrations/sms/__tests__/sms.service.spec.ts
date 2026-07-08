import { ExternalServiceException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

import { MockSmsProvider } from '../providers/mock-sms.provider';
import { TwoFactorSmsProvider } from '../providers/twofactor.provider';
import { SmsService } from '../sms.service';

describe('SmsService', () => {
  let mock: MockSmsProvider;
  let twoFactor: TwoFactorSmsProvider;

  const buildSvc = (provider: '2factor' | 'mock'): SmsService => {
    mock = new MockSmsProvider();
    twoFactor = {
      sendOtp: jest.fn(),
      sendNotification: jest.fn(),
    } as unknown as TwoFactorSmsProvider;
    const cfg = { sms: { provider } } as unknown as ConfigService;
    return new SmsService(cfg, twoFactor, mock);
  };

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('routes to mock provider when configured', async () => {
    const svc = buildSvc('mock');
    const result = await svc.sendOtp('9876543210', '123456');
    expect(result.provider).toBe('mock');
    expect(mock.getOutbox()).toHaveLength(1);
  });

  it('returns success on first 2Factor hit', async () => {
    const svc = buildSvc('2factor');
    (twoFactor.sendOtp as jest.Mock).mockResolvedValue({
      success: true,
      provider: '2factor',
      messageId: 'r-1',
    });
    const result = await svc.sendOtp('9876543210', '123456');
    expect(result.success).toBe(true);
    expect(twoFactor.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('retries up to 3 times with exponential backoff', async () => {
    const svc = buildSvc('2factor');
    (twoFactor.sendOtp as jest.Mock)
      .mockResolvedValueOnce({ success: false, provider: '2factor', error: 'fail-1' })
      .mockResolvedValueOnce({ success: false, provider: '2factor', error: 'fail-2' })
      .mockResolvedValueOnce({ success: true, provider: '2factor', messageId: 'r-3' });
    const promise = svc.sendOtp('9876543210', '123456');
    await jest.advanceTimersByTimeAsync(2_000);
    await jest.advanceTimersByTimeAsync(4_000);
    const result = await promise;
    expect(result.success).toBe(true);
    expect(twoFactor.sendOtp).toHaveBeenCalledTimes(3);
  });

  it('throws SMS_DELIVERY_FAILED after 3 failures', async () => {
    // Use real timers for this test — fake timers + multiple retry-chains
    // in one test surface as a timeout because each chain has two
    // setTimeout-based delays that need to be drained sequentially.
    jest.useRealTimers();
    const svc = buildSvc('2factor');
    (twoFactor.sendOtp as jest.Mock).mockResolvedValue({
      success: false,
      provider: '2factor',
      error: 'persistent fail',
    });
    await expect(svc.sendOtp('9876543210', '123456')).rejects.toBeInstanceOf(
      ExternalServiceException,
    );
    await expect(svc.sendOtp('9876543210', '123456').catch((e) => e)).resolves.toMatchObject({
      code: ErrorCode.SMS_DELIVERY_FAILED,
    });
  }, 30_000);
});
