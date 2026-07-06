import { Injectable, Logger } from '@nestjs/common';

import type { ISmsProvider, SmsResult } from '../sms.types';

/**
 * Mock SMS provider — used when `SMS_PROVIDER=mock` (the default in
 * `.env.example`). Logs the OTP at WARN level so a developer can copy
 * it from the console during local OTP login flows.
 *
 * Tests inject this directly to assert what would have been sent.
 */
@Injectable()
export class MockSmsProvider implements ISmsProvider {
  private readonly logger = new Logger(MockSmsProvider.name);
  private readonly outbox: Array<{ mobile: string; message: string; sentAt: Date }> = [];

  async sendOtp(mobile: string, otp: string): Promise<SmsResult> {
    this.logger.warn(`[MOCK SMS] OTP for ${mobile}: ${otp}`);
    this.outbox.push({ mobile, message: `OTP: ${otp}`, sentAt: new Date() });
    return { success: true, messageId: `mock-${Date.now()}`, provider: 'mock' };
  }

  async sendNotification(mobile: string, message: string): Promise<SmsResult> {
    this.logger.warn(`[MOCK SMS] To ${mobile}: ${message}`);
    this.outbox.push({ mobile, message, sentAt: new Date() });
    return { success: true, messageId: `mock-${Date.now()}`, provider: 'mock' };
  }

  /** Test helper. */
  getOutbox(): ReadonlyArray<{ mobile: string; message: string; sentAt: Date }> {
    return [...this.outbox];
  }

  /** Test helper. */
  clearOutbox(): void {
    this.outbox.length = 0;
  }
}
