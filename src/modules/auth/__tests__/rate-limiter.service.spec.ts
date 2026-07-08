import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

import { AuthRateLimiterService } from '../services/rate-limiter.service';

const buildService = (perMobile = 3): AuthRateLimiterService =>
  new AuthRateLimiterService({
    sms: { maxAttemptsPerHour: perMobile },
  } as unknown as ConfigService);

describe('AuthRateLimiterService', () => {
  it('allows up to maxAttemptsPerHour requests per mobile', () => {
    const svc = buildService(3);
    expect(() => svc.checkOtpRequest('9876543210', '1.1.1.1')).not.toThrow();
    expect(() => svc.checkOtpRequest('9876543210', '1.1.1.1')).not.toThrow();
    expect(() => svc.checkOtpRequest('9876543210', '1.1.1.1')).not.toThrow();
    expect(() => svc.checkOtpRequest('9876543210', '1.1.1.1')).toThrow(BusinessException);
  });

  it('reports OTP_TOO_MANY_ATTEMPTS when mobile limit is exceeded', () => {
    const svc = buildService(1);
    svc.checkOtpRequest('9876543210', '1.1.1.1');
    try {
      svc.checkOtpRequest('9876543210', '1.1.1.1');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as BusinessException).code).toBe(ErrorCode.OTP_TOO_MANY_ATTEMPTS);
    }
  });

  it('reports RATE_LIMIT_EXCEEDED when the IP cap is hit (10/hour) across mobiles', () => {
    const svc = buildService(20);
    for (let i = 0; i < 10; i += 1) {
      svc.checkOtpRequest(`98765432${i.toString().padStart(2, '0')}`, '8.8.8.8');
    }
    try {
      svc.checkOtpRequest('9999999999', '8.8.8.8');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as BusinessException).code).toBe(ErrorCode.RATE_LIMIT_EXCEEDED);
    }
  });

  it('reset() clears windows', () => {
    const svc = buildService(1);
    svc.checkOtpRequest('9876543210', '1.1.1.1');
    svc.reset();
    expect(() => svc.checkOtpRequest('9876543210', '1.1.1.1')).not.toThrow();
  });
});
