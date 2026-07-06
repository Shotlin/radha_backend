import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ConfigService } from '@/config/config.service';
import { AuthModule } from '@/modules/auth/auth.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { AdminImpersonationController } from './controllers/admin-impersonation.controller';
import { ImpersonationGuard } from './guards/impersonation.guard';
import { ImpersonationActionLoggerMiddleware } from './middleware/impersonation-action-logger.middleware';
import { ImpersonationActionsRepository } from './repositories/impersonation-actions.repository';
import { ImpersonationSessionsRepository } from './repositories/impersonation-sessions.repository';
import { AdminImpersonationService } from './services/admin-impersonation.service';

/**
 * BE-53 — Admin Impersonation Tool.
 *
 * Wires:
 *   - `AdminImpersonationController` for the three REST endpoints.
 *   - `AdminImpersonationService` (start/end + JWT minting + audit).
 *   - `ImpersonationSessionsRepository` / `ImpersonationActionsRepository`.
 *   - `ImpersonationGuard` exported so other modules can apply it on
 *     destructive routes (or `app.module.ts` can register globally).
 *   - `ImpersonationActionLoggerMiddleware` applied to every route so
 *     anything done under an impersonation token lands in
 *     `impersonation_actions`.
 *
 * Per the BE-53 brief, this module is intentionally NOT registered
 * in `app.module.ts`. The integration step lives in the BE-53
 * handoff doc.
 */
@Module({
  imports: [
    AuthModule,
    ObservabilityModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.jwt.accessTokenSecret }),
    }),
  ],
  controllers: [AdminImpersonationController],
  providers: [
    ImpersonationSessionsRepository,
    ImpersonationActionsRepository,
    AdminImpersonationService,
    ImpersonationGuard,
    ImpersonationActionLoggerMiddleware,
  ],
  exports: [AdminImpersonationService, ImpersonationGuard],
})
export class AdminImpersonationModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Run the action logger on every route. The middleware
    // short-circuits for non-impersonation tokens, so the cost on
    // normal traffic is a single bearer-token regex test.
    consumer
      .apply(ImpersonationActionLoggerMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
