import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';
import type { FcmFailureReason } from '@/modules/notifications/types/notification.types';

import { FirebaseAdminAppService } from './firebase-admin-app.service';
import type { FcmSendParams, FcmSendResult, FcmTokenResult, IFcmService } from './fcm.types';

/**
 * BE-24 — FCM (Firebase Cloud Messaging) wrapper.
 *
 * The Firebase Admin app itself is resolved via `FirebaseAdminAppService`
 * (Phase 13 extraction) — shared with `FirebaseAuthVerifierService`
 * (Google Sign-In token verification) so both consumers use the same
 * named app off the same service-account credential. This class owns
 * only the `messaging()` handle and the send/error-mapping logic.
 *
 * Permanent-failure tokens (FCM error codes
 * `messaging/registration-token-not-registered` and
 * `messaging/invalid-argument`) are returned with `permanentFailure=true`
 * so `FcmTokenCleanupService` can mark them inactive in the DB.
 */
@Injectable()
export class FcmService implements IFcmService {
  private readonly logger = new Logger(FcmService.name);
  private messaging: unknown = null;

  constructor(
    private readonly _config: ConfigService,
    // Defaulted (not just optional) so existing call sites that construct
    // `FcmService` directly with one argument — e.g.
    // `fcm.service.spec.ts`'s `new FcmService(buildConfig())` — keep
    // compiling unchanged. Nest's DI container always supplies the real
    // singleton explicitly; the default only ever engages in that kind of
    // direct-construction test.
    private readonly firebaseAdminApp: FirebaseAdminAppService = new FirebaseAdminAppService(),
  ) {
    // ConfigService is reserved for future BE-24 keys (project id) once
    // they're added to the typed env schema.
    void this._config;
  }

  isAvailable(): boolean {
    return this.firebaseAdminApp.isAvailable();
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

    const wasAvailable = this.firebaseAdminApp.isAvailable();
    const messaging = await this.lazyInit();
    if (!messaging) {
      const reason = wasAvailable
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
    if (this.messaging) return this.messaging;

    const app = await this.firebaseAdminApp.getApp();
    if (!app) return null;

    try {
      type FirebaseAdminModule = typeof import('firebase-admin');
      const mod = (await import('firebase-admin').catch(() => null)) as FirebaseAdminModule | null;
      if (!mod) {
        this.logger.warn('fcm.disabled', { reason: 'firebase-admin not installed' });
        return null;
      }

      this.messaging = (mod.messaging as (app: unknown) => unknown)(app);
      this.logger.log('fcm.initialised');
      return this.messaging;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.error('fcm.init.failed', { message });
      return null;
    }
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
