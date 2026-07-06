import { Injectable } from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

interface Window {
  count: number;
  resetAt: number;
}

/**
 * BE-06 rate limiter — in-memory only.
 *
 * Two windows tracked per OTP request: per-mobile (configurable, default 3
 * requests / hour from `OTP_MAX_ATTEMPTS_PER_HOUR`) and per-IP (10 / hour
 * hard-coded; can be lifted into config later).
 *
 * BE-46 (Free-Tier Rate Limiting & Quotas) replaces this with Redis so
 * the limit survives process restarts and works across replicas. The
 * public surface (`checkOtpRequest`) is identical, so swap is a one-liner.
 */
@Injectable()
export class AuthRateLimiterService {
  private readonly mobileWindows = new Map<string, Window>();
  private readonly ipWindows = new Map<string, Window>();
  private static readonly WINDOW_MS = 60 * 60 * 1000;
  private static readonly IP_LIMIT = 10;

  constructor(private readonly config: ConfigService) {}

  checkOtpRequest(mobile: string, ipAddress: string): void {
    const now = Date.now();
    const mobileLimit = this.config.sms.maxAttemptsPerHour;

    if (this.exceeds(this.mobileWindows, mobile, mobileLimit, now)) {
      throw new BusinessException(
        ErrorCode.OTP_TOO_MANY_ATTEMPTS,
        `Too many OTP requests for this number. Try again later.`,
        { metadata: { scope: 'mobile', limit: mobileLimit } },
      );
    }
    if (this.exceeds(this.ipWindows, ipAddress, AuthRateLimiterService.IP_LIMIT, now)) {
      throw new BusinessException(
        ErrorCode.RATE_LIMIT_EXCEEDED,
        `Too many OTP requests from this network. Try again later.`,
        { metadata: { scope: 'ip', limit: AuthRateLimiterService.IP_LIMIT } },
      );
    }
  }

  reset(): void {
    this.mobileWindows.clear();
    this.ipWindows.clear();
  }

  private exceeds(map: Map<string, Window>, key: string, limit: number, now: number): boolean {
    const win = map.get(key);
    if (!win || win.resetAt <= now) {
      map.set(key, { count: 1, resetAt: now + AuthRateLimiterService.WINDOW_MS });
      return false;
    }
    win.count += 1;
    return win.count > limit;
  }
}
