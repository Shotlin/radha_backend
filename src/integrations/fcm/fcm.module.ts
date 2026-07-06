import { Global, Module } from '@nestjs/common';

import { FcmService } from './fcm.service';

/**
 * Wires the FCM integration as a global provider so BE-24 (and any
 * future module that wants push) can inject `FcmService` without
 * importing this module everywhere.
 */
@Global()
@Module({
  providers: [FcmService],
  exports: [FcmService],
})
export class FcmModule {}
