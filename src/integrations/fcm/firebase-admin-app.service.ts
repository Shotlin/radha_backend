import { Injectable, Logger } from '@nestjs/common';

/**
 * Shared lazy Firebase Admin app initializer.
 *
 * Extracted from `FcmService` (Phase 13) so both push notifications
 * (`FcmService`, BE-24) and Google Sign-In token verification
 * (`FirebaseAuthVerifierService`, Phase 13) resolve the SAME named app
 * instance off the SAME service-account credential, instead of each
 * rolling its own `firebase-admin` init. One project, one credential,
 * two consumers.
 *
 * `firebase-admin` is loaded lazily so the API process doesn't pay the
 * SDK init cost when neither push nor Google Sign-In is actually used.
 *
 * Two init paths are supported (identical to `FcmService`'s original):
 *   1. `FCM_SERVICE_ACCOUNT_JSON`   — full service-account JSON inline
 *   2. `FCM_SERVICE_ACCOUNT_BASE64` — base64-encoded JSON
 *   3. nothing — `getApp()` resolves to `null`, callers degrade
 *      gracefully (FCM sends report a global error; Firebase Auth
 *      exchange throws `AUTHENTICATION_REQUIRED`).
 */
@Injectable()
export class FirebaseAdminAppService {
  private static readonly APP_NAME = 'radha-fcm';

  private readonly logger = new Logger(FirebaseAdminAppService.name);
  private app: unknown = null;
  private initialised = false;
  private initFailed = false;

  /**
   * Whether credentials are configured and parse cleanly. Does NOT
   * guarantee a successful `firebase-admin` init (network/cert errors
   * are only discoverable on the real `getApp()` call) — matches the
   * exact semantics `FcmService.isAvailable()` had before extraction.
   */
  isAvailable(): boolean {
    return !this.initFailed && !!this.readServiceAccountKey();
  }

  async getApp(): Promise<unknown | null> {
    if (this.initFailed) return null;
    if (this.initialised) return this.app;

    const serviceAccount = this.readServiceAccountKey();
    if (!serviceAccount) {
      this.initFailed = true;
      this.logger.warn('firebase_admin.disabled', { reason: 'no service account configured' });
      return null;
    }

    try {
      type FirebaseAdminModule = typeof import('firebase-admin');
      const mod = (await import('firebase-admin').catch(() => null)) as FirebaseAdminModule | null;
      if (!mod) {
        this.initFailed = true;
        this.logger.warn('firebase_admin.disabled', { reason: 'firebase-admin not installed' });
        return null;
      }

      const apps = mod.apps as Array<{ name: string }>;
      const existing = apps.find((a) => a?.name === FirebaseAdminAppService.APP_NAME);
      this.app = existing
        ? existing
        : mod.initializeApp(
            {
              credential: mod.credential.cert(
                serviceAccount as Parameters<typeof mod.credential.cert>[0],
              ),
            },
            FirebaseAdminAppService.APP_NAME,
          );

      this.initialised = true;
      this.logger.log('firebase_admin.initialised');
      return this.app;
    } catch (err) {
      this.initFailed = true;
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.error('firebase_admin.init.failed', { message });
      return null;
    }
  }

  /**
   * Read the service-account key from env. Two formats supported:
   *   - `FCM_SERVICE_ACCOUNT_JSON` — inline JSON string
   *   - `FCM_SERVICE_ACCOUNT_BASE64` — base64-encoded JSON
   *
   * Reading via `process.env` directly, matching `FcmService`'s
   * original approach — see that file's own comment for why (BE-24
   * predates these being added to the typed env schema; Phase 13 adds
   * them to `env.schema.ts` for validation, but this read stays
   * `process.env`-based so it works identically whether or not the
   * typed `ConfigService` wires it through).
   */
  private readServiceAccountKey(): Record<string, unknown> | null {
    const inline = process.env.FCM_SERVICE_ACCOUNT_JSON;
    if (inline && inline.trim().length > 0) {
      try {
        return JSON.parse(inline) as Record<string, unknown>;
      } catch {
        this.logger.error('firebase_admin.config.invalid', {
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
        this.logger.error('firebase_admin.config.invalid', {
          reason: 'FCM_SERVICE_ACCOUNT_BASE64 is not valid base64-JSON',
        });
        return null;
      }
    }
    return null;
  }
}
