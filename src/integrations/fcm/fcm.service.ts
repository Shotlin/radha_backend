import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';
import type { FcmFailureReason } from '@/modules/notifications/types/notification.types';

import type { FcmSendParams, FcmSendResult, FcmTokenResult, IFcmService } from './fcm.types';

/**
 * BE-24 — FCM (Firebase Cloud Messaging) wrapper.
 *
 * `firebase-admin` is loaded lazily so the API process doesn't pay the
 * SDK init cost when push isn't actually used. The dynamic import
 * mirrors the BE-13 S3 / BE-21 ExcelJS pattern: the SDK is a runtime
 * dep that the package.json declares but the lazy load lets the
 * server boot even if it isn't installed (for unit tests, dev boxes
 * that haven't pulled the heavy dep, etc.).
 *
 * Three init paths are supported:
 *   1. `FCM_SERVICE_ACCOUNT_JSON`   — full service-account JSON inline
 *   2. `FCM_SERVICE_ACCOUNT_BASE64` — base64-encoded JSON
 *   3. nothing — provider returns `available=false` and every send
 *      reports a global error so the router can fall through to the
 *      other channels.
 *
 * Permanent-failure tokens (FCM error codes
 * `messaging/registration-token-not-registered` and
 * `messaging/invalid-argument`) are returned with `permanentFailure=true`
 * so `FcmTokenCleanupService` can mark them inactive in the DB.
 */
@Injectable()
export class FcmService implements IFcmService {
  private readonly logger = new Logger(FcmService.name);
  private app: unknown = null;
  private messaging: unknown = null;
  private initialised = false;
  private initFailed = false;

  constructor(private readonly _config: ConfigService) {
    // ConfigService is reserved for future BE-24 keys (project id) once
    // they're added to the typed env schema.
    void this._config;
  }

  isAvailable(): boolean {
    return !this.initFailed && !!this.readServiceAccountKey();
  }

  async send(params: FcmSendParams): Promise<FcmSendResult> {
    const tokens = Array.from(new Set(params.tokens.filter(Boolean)));
    if (tokens.length === 0) {
      return {
        successCount: 0,
        failureCount: 0,
        perToken: [],
        globalError: 'no tokens provided',
      };
    }

    const messaging = await this.lazyInit();
    if (!messaging) {
      const reason = this.initFailed
        ? 'firebase-admin unavailable'
        : 'FCM credentials not configured';
      return {
        successCount: 0,
        failureCount: tokens.length,
        perToken: tokens.map<FcmTokenResult>((token) => ({
          token,
          success: false,
          error: reason,
          permanentFailure: false,
        })),
        globalError: reason,
      };
    }

    const message = {
      tokens,
      notification: {
        title: params.title,
        body: params.body,
        ...(params.imageUrl ? { imageUrl: params.imageUrl } : {}),
      },
      data: this.stringifyData(params.data),
      android: {
        priority: (params.priority ?? 'high') === 'high' ? 'high' : 'normal',
        ...(params.clickAction
          ? {
              notification: {
                clickAction: params.clickAction,
              },
            }
          : {}),
      },
      apns: {
        headers: {
          'apns-priority': params.priority === 'high' ? '10' : '5',
        },
      },
    };

    try {
      const fcm = messaging as {
        sendEachForMulticast: (msg: typeof message) => Promise<{
          responses: Array<{
            success: boolean;
            messageId?: string;
            error?: { code?: string; message?: string };
          }>;
          successCount: number;
          failureCount: number;
        }>;
      };

      const response = await fcm.sendEachForMulticast(message);

      const perToken: FcmTokenResult[] = response.responses.map((r, idx) => {
        const token = tokens[idx];
        if (r.success) {
          return {
            token,
            success: true,
            messageId: r.messageId,
            permanentFailure: false,
          };
        }
        const reason = this.classifyError(r.error?.code);
        return {
          token,
          success: false,
          error: r.error?.message ?? r.error?.code ?? 'unknown',
          reason,
          permanentFailure: reason === 'unregistered' || reason === 'invalid_argument',
        };
      });

      return {
        successCount: response.successCount,
        failureCount: response.failureCount,
        perToken,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.error('fcm.send.failed', { message });
      return {
        successCount: 0,
        failureCount: tokens.length,
        perToken: tokens.map<FcmTokenResult>((token) => ({
          token,
          success: false,
          error: message,
          permanentFailure: false,
        })),
        globalError: message,
      };
    }
  }

  /* ───────────────────── Internal ───────────────────── */

  private async lazyInit(): Promise<unknown> {
    if (this.initFailed) return null;
    if (this.initialised) return this.messaging;

    const serviceAccount = this.readServiceAccountKey();
    if (!serviceAccount) {
      this.initFailed = true;
      this.logger.warn('fcm.disabled', { reason: 'no service account configured' });
      return null;
    }

    try {
      type FirebaseAdminModule = typeof import('firebase-admin');
      const mod = (await import('firebase-admin').catch(() => null)) as FirebaseAdminModule | null;
      if (!mod) {
        this.initFailed = true;
        this.logger.warn('fcm.disabled', { reason: 'firebase-admin not installed' });
        return null;
      }

      const apps = mod.apps as Array<{ name: string }>;
      const existing = apps.find((a) => a?.name === 'radha-fcm');
      if (existing) {
        this.app = existing;
      } else {
        this.app = mod.initializeApp(
          {
            credential: mod.credential.cert(
              serviceAccount as Parameters<typeof mod.credential.cert>[0],
            ),
          },
          'radha-fcm',
        );
      }

      this.messaging = (mod.messaging as (app: unknown) => unknown)(this.app);
      this.initialised = true;
      this.logger.log('fcm.initialised');
      return this.messaging;
    } catch (err) {
      this.initFailed = true;
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.error('fcm.init.failed', { message });
      return null;
    }
  }

  /**
   * Read the service-account key from env. Two formats supported:
   *   - `FCM_SERVICE_ACCOUNT_JSON` — inline JSON string
   *   - `FCM_SERVICE_ACCOUNT_BASE64` — base64-encoded JSON
   *
   * Reading via `process.env` directly so the BE-02 typed env schema
   * stays untouched (BE-24 declares the new vars in its handoff).
   */
  private readServiceAccountKey(): Record<string, unknown> | null {
    const inline = process.env.FCM_SERVICE_ACCOUNT_JSON;
    if (inline && inline.trim().length > 0) {
      try {
        return JSON.parse(inline) as Record<string, unknown>;
      } catch {
        this.logger.error('fcm.config.invalid', {
          reason: 'FCM_SERVICE_ACCOUNT_JSON is not valid JSON',
        });
        return null;
      }
    }
    const b64 = process.env.FCM_SERVICE_ACCOUNT_BASE64;
    if (b64 && b64.trim().length > 0) {
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        return JSON.parse(decoded) as Record<string, unknown>;
      } catch {
        this.logger.error('fcm.config.invalid', {
          reason: 'FCM_SERVICE_ACCOUNT_BASE64 is not valid base64-JSON',
        });
        return null;
      }
    }
    return null;
  }

  private classifyError(code?: string): FcmFailureReason {
    if (!code) return 'unknown';
    if (code.includes('registration-token-not-registered')) return 'unregistered';
    if (code.includes('invalid-registration-token')) return 'invalid_argument';
    if (code.includes('invalid-argument')) return 'invalid_argument';
    if (code.includes('mismatched-credential') || code.includes('sender-id-mismatch')) {
      return 'sender_id_mismatch';
    }
    if (code.includes('unavailable') || code.includes('internal-error')) {
      return 'unavailable';
    }
    return 'unknown';
  }

  /** FCM only accepts string-keyed string-valued data. Coerce safely. */
  private stringifyData(data?: Record<string, string>): Record<string, string> | undefined {
    if (!data) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  }
}
