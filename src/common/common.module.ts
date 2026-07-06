import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, Reflector } from '@nestjs/core';

import { RequestContextModule } from './context/request-context.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { TimeoutInterceptor } from './interceptors/timeout.interceptor';
import { RequestIdMiddleware } from './middleware/request-id.middleware';
import { RequestLoggerMiddleware } from './middleware/request-logger.middleware';

/**
 * Cross-cutting middleware, filters, and interceptors live here.
 *
 *   - RequestContextModule (CLS) is mounted globally so context flows
 *     through every async hop.
 *   - RequestIdMiddleware is wired up via NestModule.configure() so it
 *     runs immediately after Cls middleware and stamps the response
 *     header before any handler executes.
 *   - GlobalExceptionFilter and ResponseInterceptor are bound through
 *     APP_FILTER / APP_INTERCEPTOR tokens so they apply to every
 *     route without per-controller wiring.
 */
@Module({
  imports: [RequestContextModule],
  providers: [
    Reflector,
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useFactory: () => new TimeoutInterceptor() },
  ],
  exports: [RequestContextModule],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, RequestLoggerMiddleware).forRoutes('*');
  }
}
