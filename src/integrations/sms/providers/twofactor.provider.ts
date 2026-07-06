import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';

import type { ISmsProvider, SmsResult } from '../sms.types';

interface TwoFactorResponse {
  /** '`Success`' | '`Error`' */
  Status?: string;
  /** Session id on success; human-readable reason on failure. */
  Details?: string;
}

/**
 * 2Factor.in OTP provider.
 *
 * RADHA generates and bcrypt-hashes its own OTP in `AuthService`, so we use
 * 2Factor's "deliver a specific OTP through a DLT template" endpoint (not
 * AUTOGEN — that would make 2Factor own the code):
 *
 *   GET https://2factor.in/API/V1/{apiKey}/SMS/{phone}/{otp}/{template}
 *
 * Success response: `{ "Status": "Success", "Details": "<session-id>" }`.
 * Numbers are sent as the bare 10-digit Indian form (auth normalises to that).
 * No SDK dependency — uses the global `fetch`, mirroring the AI/LLM providers.
 */
@Injectable()
export class TwoFactorSmsProvider implements ISmsProvider {
  private readonly logger = new Logger(TwoFactorSmsProvider.name);
  private readonly baseUrl = 'https://2factor.in/API/V1';

  constructor(private readonly config: ConfigService) {}

  async sendOtp(mobile: string, otp: string): Promise<SmsResult> {
    const { apiKey, templateId } = this.config.sms;

    // Dev-safety guard: a blank or `dev-*` placeholder key short-circuits to a
    // logged success so local OTP flows work without a real 2Factor account
    // (and without spending SMS credits). `env.schema.ts` rejects placeholder
    // values when NODE_ENV=production, so this branch never runs in prod.
    if (!apiKey || apiKey === 'dev-mock' || apiKey.startsWith('dev-')) {
      this.logger.warn(`[2FACTOR DEV-SHORTCIRCUIT] OTP for ${mobile}: ${otp}`);
      return {
        success: true,
        messageId: `dev-shortcircuit-${Date.now()}`,
        provider: '2factor',
      };
    }

    const phone = mobile.replace(/\D/g, '');
    const segments = [apiKey, 'SMS', phone, otp];
    if (templateId) segments.push(templateId);
    const url = `${this.baseUrl}/${segments.map(encodeURIComponent).join('/')}`;

    try {
      const res = await fetch(url, { method: 'GET' });
      const body = (await res.json().catch(() => ({}))) as TwoFactorResponse;
      if (res.ok && body.Status === 'Success') {
        return { success: true, messageId: body.Details, provider: '2factor' };
      }
      const message = body.Details ?? `2Factor returned status ${res.status}`;
      this.logger.warn('twofactor.send.failed', { status: res.status, message });
      return { success: false, provider: '2factor', error: message };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.error('twofactor.send.network_error', { message });
      return { success: false, provider: '2factor', error: message };
    }
  }

  async sendNotification(_mobile: string, _message: string): Promise<SmsResult> {
    // Transactional SMS (BE-24 notifications) can extend to 2Factor's
    // ADDON_SERVICES/SEND/TSMS endpoint; not needed for OTP delivery.
    return {
      success: false,
      provider: '2factor',
      error: 'sendNotification not implemented',
    };
  }
}
