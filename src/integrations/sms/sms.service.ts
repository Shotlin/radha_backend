import { Injectable, Logger } from '@nestjs/common';

import { ExternalServiceException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

import { MockSmsProvider } from './providers/mock-sms.provider';
import { TwoFactorSmsProvider } from './providers/twofactor.provider';
import type { ISmsProvider, SmsResult } from './sms.types';

const RETRY_SCHEDULE_MS = [0, 2_000, 4_000] as const;

/**
 * Public-facing SMS service.
 *
 * Picks a provider once at construction time based on
 * `ConfigService.sms.provider` and applies a 3-attempt retry chain
 * (immediate / +2s / +4s) on transient failures. Permanent failures
 * surface as `ExternalServiceException(SMS_DELIVERY_FAILED)` so the
 * AuthService can translate that into a clean user-facing error.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly provider: ISmsProvider;

  constructor(
    config: ConfigService,
    private readonly twoFactor: TwoFactorSmsProvider,
    private readonly mock: MockSmsProvider,
  ) {
    // Respect SMS_PROVIDER. `2factor` ⇒ the real 2Factor.in provider (which
    // itself short-circuits to a logged success when the API key is a `dev-*`
    // placeholder, so local flows never accidentally spend credits); anything
    // else ⇒ the mock provider. Production validation forces SMS_PROVIDER=2factor
    // with a real key, so live OTP delivery is guaranteed in prod.
    const cfgProvider = config.sms.provider;
    const useMock = cfgProvider !== '2factor';
    this.provider = useMock ? this.mock : this.twoFactor;
    this.logger.log(`SMS provider resolved: ${useMock ? 'mock' : '2factor'} (cfg=${cfgProvider})`);
  }

  async sendOtp(mobile: string, otp: string): Promise<SmsResult> {
    let last: SmsResult | undefined;
    for (const delay of RETRY_SCHEDULE_MS) {
      if (delay > 0) await this.sleep(delay);
      last = await this.provider.sendOtp(mobile, otp);
      if (last.success) return last;
      this.logger.warn('sms.retry', { error: last.error, provider: last.provider });
    }
    throw new ExternalServiceException(
      'SMS',
      new Error(last?.error ?? 'unknown SMS error'),
      ErrorCode.SMS_DELIVERY_FAILED,
    );
  }

  /** Convenience hook for BE-09 staff-invite + BE-24 notifications. */
  async sendNotification(mobile: string, message: string, templateId?: string): Promise<SmsResult> {
    return this.provider.sendNotification(mobile, message, templateId);
  }

  /** Used by tests to inspect the mock outbox. */
  getMockProvider(): MockSmsProvider {
    return this.mock;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
