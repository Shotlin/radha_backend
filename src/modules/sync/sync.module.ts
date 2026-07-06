import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';

import { SyncController } from './controllers/sync.controller';
import { IdempotencyMiddleware } from './middleware/idempotency.middleware';
import { IdempotencyRecordsRepository } from './repositories/idempotency-records.repository';
import { IdempotencyService } from './services/idempotency.service';
import { SyncService } from './services/sync.service';

/**
 * BE-44 — Offline-First Sync + Idempotency module.
 *
 * Wires:
 *   - `SyncController` for the `POST /sync/*` and `GET /sync/changes`
 *     endpoints.
 *   - `IdempotencyMiddleware` applied to every mutating route so
 *     replayed requests carrying the same `Idempotency-Key` collapse
 *     into a single side effect.
 *   - `IdempotencyService` + `IdempotencyRecordsRepository` for the
 *     storage layer.
 *   - `SyncService` for the bulk-sync orchestrator (last-write-wins
 *     by Lamport timestamp, server-wins for security-sensitive
 *     fields, per-item error map).
 *
 * Per the BE-44 brief this module is NOT registered in
 * `app.module.ts` — that step lives in the BE-44 handoff doc.
 */
@Module({
  imports: [AuthModule],
  controllers: [SyncController],
  providers: [
    IdempotencyRecordsRepository,
    IdempotencyService,
    SyncService,
    IdempotencyMiddleware,
  ],
  exports: [IdempotencyService, SyncService],
})
export class SyncModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Apply idempotency to every mutating method. The middleware
    // itself short-circuits on GET/HEAD/OPTIONS, but listing the
    // methods explicitly here keeps the wiring intent readable.
    consumer
      .apply(IdempotencyMiddleware)
      .forRoutes(
        { path: '*', method: RequestMethod.POST },
        { path: '*', method: RequestMethod.PUT },
        { path: '*', method: RequestMethod.PATCH },
        { path: '*', method: RequestMethod.DELETE },
      );
  }
}
