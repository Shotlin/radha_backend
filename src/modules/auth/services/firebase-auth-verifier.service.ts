import { Injectable, Logger } from '@nestjs/common';

import { FirebaseAdminAppService } from '@/integrations/fcm/firebase-admin-app.service';
import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

export interface FirebaseTokenClaims {
  firebaseUid: string;
  email: string | null;
  emailVerified: boolean;
}

/**
 * Phase 13 — verifies a Firebase Auth ID token (issued client-side after
 * Google Sign-In) via the Firebase Admin SDK.
 *
 * `verifyIdToken()` handles signature verification against Google's
 * rotating public keys, expiry, issuer, and audience-vs-project-id
 * internally — no custom JWKS/HS256 handling needed here, unlike a
 * hand-rolled JWT verifier would require.
 *
 * Shares its Firebase Admin app with `FcmService` via
 * `FirebaseAdminAppService` — one project, one credential, two
 * consumers.
 */
@Injectable()
export class FirebaseAuthVerifierService {
  private readonly logger = new Logger(FirebaseAuthVerifierService.name);

  constructor(private readonly firebaseAdminApp: FirebaseAdminAppService) {}

  async verify(idToken: string): Promise<FirebaseTokenClaims> {
    const app = await this.firebaseAdminApp.getApp();
    if (!app) {
      throw new BusinessException(
        ErrorCode.AUTHENTICATION_REQUIRED,
        'Google Sign-In is not configured on the server',
      );
    }

    try {
      type FirebaseAdminModule = typeof import('firebase-admin');
      const mod = (await import('firebase-admin')) as FirebaseAdminModule;
      const decoded = await mod.auth(app as never).verifyIdToken(idToken);
      return {
        firebaseUid: decoded.uid,
        email: decoded.email ?? null,
        emailVerified: decoded.email_verified ?? false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.warn('firebase_auth.verify_failed', { message });
      throw new BusinessException(
        ErrorCode.AUTHENTICATION_REQUIRED,
        'Invalid or expired Google sign-in token',
      );
    }
  }
}
