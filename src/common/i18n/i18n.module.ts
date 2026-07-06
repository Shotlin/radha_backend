import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { I18nService } from './i18n.service';
import { AcceptLanguageMiddleware } from './middleware/accept-language.middleware';

/**
 * BE-42 — Global i18n module.
 *
 * Exports `I18nService` so any controller, service, or notification
 * formatter can inject it without re-declaring the dependency in
 * each feature module. Marked `@Global()` for that reason — same
 * pattern Nest's own `ConfigModule.forRoot({ isGlobal: true })`
 * uses.
 *
 * `AcceptLanguageMiddleware` is bound to every route via the standard
 * `NestModule.configure` hook. Once Mobile_App attaches an
 * `Accept-Language` header, downstream handlers can read
 * `req.locale` without any further wiring.
 *
 * NOTE: per the implementation brief, this module is registered by
 * its consuming surfaces — `app.module.ts` is intentionally not
 * touched here. To wire it in, add `I18nModule` to `AppModule.imports`
 * in a follow-up step.
 */
@Global()
@Module({
  providers: [I18nService, AcceptLanguageMiddleware],
  exports: [I18nService],
})
export class I18nModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AcceptLanguageMiddleware).forRoutes('*');
  }
}
