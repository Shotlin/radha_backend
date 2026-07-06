import { Injectable, Optional } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { RequestContextService } from '@/common/context/request-context.service';
import { redactPII } from '@/common/utils/redact.utils';

import { ILoggerService, LogContext, LogLevel } from './logger.types';

/**
 * Application-wide logger that:
 *   1. Auto-enriches every entry with the current requestId / userId
 *      / tenantId from the CLS-backed RequestContextService.
 *   2. Recursively redacts PII from any structured payload.
 *   3. Delegates to `nestjs-pino`'s `PinoLogger` so output stays
 *      consistent with the HTTP request logs.
 */
@Injectable()
export class LoggerService implements ILoggerService {
  constructor(
    private readonly pino: PinoLogger,
    @Optional() private readonly context?: RequestContextService,
  ) {
    this.pino.setContext('app');
  }

  /** Build the structured payload that accompanies every log line. */
  private envelope(extra?: LogContext): LogContext {
    const base = redactPII(extra ?? {});
    if (!this.context) return base;
    return {
      ...base,
      requestId: base.requestId ?? this.context.getRequestId(),
      userId: base.userId ?? this.context.getUserId(),
      tenantId: base.tenantId ?? this.context.getTenantId(),
    };
  }

  error(message: string, ctx?: LogContext): void {
    this.pino.error(this.envelope(ctx), message);
  }
  warn(message: string, ctx?: LogContext): void {
    this.pino.warn(this.envelope(ctx), message);
  }
  info(message: string, ctx?: LogContext): void {
    this.pino.info(this.envelope(ctx), message);
  }
  debug(message: string, ctx?: LogContext): void {
    this.pino.debug(this.envelope(ctx), message);
  }
  verbose(message: string, ctx?: LogContext): void {
    this.pino.trace(this.envelope(ctx), message);
  }

  /**
   * Dispatch helper. Two call shapes are accepted to satisfy both our
   * `ILoggerService` interface and Nest's built-in `LoggerService`:
   *
   *   log(level, message, ctx?)
   *   log(message, optionalNestCtx?)
   */
  log(level: LogLevel, message: string, ctx?: LogContext): void;
  log(message: unknown, ctx?: string): void;
  log(...args: unknown[]): void {
    const validLevels: ReadonlyArray<LogLevel> = ['error', 'warn', 'info', 'debug', 'verbose'];
    const [first, second, third] = args;
    if (typeof first === 'string' && validLevels.includes(first as LogLevel)) {
      const level = first as LogLevel;
      const message = typeof second === 'string' ? second : '';
      this[level](message, third as LogContext | undefined);
      return;
    }
    this.info(String(first ?? ''));
  }

  logError(error: Error, ctx?: LogContext): void {
    this.error(error.message, {
      ...ctx,
      error: { name: error.name, message: error.message, stack: error.stack },
    });
  }

  child(bindings: Record<string, unknown>): ILoggerService {
    const safe = redactPII(bindings);
    const childPino = (
      this.pino as PinoLogger & {
        logger: { child: (b: Record<string, unknown>) => unknown };
      }
    ).logger.child(safe);
    const wrapped = Object.assign(Object.create(PinoLogger.prototype) as PinoLogger, this.pino, {
      logger: childPino,
    });
    return new LoggerService(wrapped, this.context);
  }
}
