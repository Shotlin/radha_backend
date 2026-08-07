import { Global, Module } from '@nestjs/common';

import { FcmService } from './fcm.service';
import { FirebaseAdminAppService } from './firebase-admin-app.service';

/**
 * Wires the FCM integration as a global provider so BE-24 (and any
 * future module that wants push) can inject `FcmService` without
 * importing this module everywhere. `FirebaseAdminAppService` is
 * exported too (Phase 13) so `AuthModule`'s `FirebaseAuthVerifierService`
 * can share the same Firebase Admin app/credential instead of
 * duplicating the init logic.
 */
@Global()
@Module({
  providers: [FcmService, FirebaseAdminAppService],
  exports: [FcmService, FirebaseAdminAppService],
})
export class FcmModule {}
