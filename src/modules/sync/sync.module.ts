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
 *   - `IdempotencyMiddleware` applied to sync's own mutating routes so
 *     replayed requests carrying the same `Idempotency-Key` collapse
 *     into a single side effect.
 *   - `IdempotencyService` + `IdempotencyRecordsRepository` for the
 *     storage layer.
 *   - `SyncService` for the bulk-sync orchestrator (last-write-wins
 *     by Lamport timestamp, server-wins for security-sensitive
 *     fields, per-item error map).
 *
 * Per the BE-44 brief this module is NOT registered in
 * `app.module.ts` — that step lives in the BE-44 handoff doc. (In
 * practice it IS registered — app.module.ts imports SyncModule — that
 * doc note is stale; see the BE-58 fix below for why that mattered.)
 *
 * BE-58 correction: this middleware used to be registered against
 * `{path: '*', ...}` (every mutating route app-wide, not just `/sync/*`).
 * That was never safe: NestJS runs middleware BEFORE guards, so on any
 * `@UseGuards(JwtAuthGuard)`-protected route `req.user` isn't populated
 * yet, and the middleware's own `resolveUserId()` check silently skips
 * idempotency on a cache MISS — but on a cache HIT it does NOT check
 * `userId` first, so once *any* code path (e.g. a route implementing
 * idempotency explicitly, like `ExpiryService.createRecord`) persists a
 * record under a given key, this middleware would intercept a REPLAY of
 * that same key on ANY OTHER route too, hash the raw pre-validation
 * request body (not the parsed/coerced DTO the real handler sees), get a
 * mismatched hash, and throw a false `IDEMPOTENCY_KEY_REUSE` 409 —
 * discovered live via Phase 8's Idempotency-Key verification. Scoping
 * `forRoutes` down to `/sync/*` (this module's own routes) is the fix:
 * sync's own controller already guarantees `req.user` is populated
 * before its handlers run via the same guard stack, and this middleware
 * now only ever sees sync's own request shapes.
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
    consumer
      .apply(IdempotencyMiddleware)
      .forRoutes(
        { path: 'sync/*', method: RequestMethod.POST },
        { path: 'sync/*', method: RequestMethod.PUT },
        { path: 'sync/*', method: RequestMethod.PATCH },
        { path: 'sync/*', method: RequestMethod.DELETE },
      );
  }
}
