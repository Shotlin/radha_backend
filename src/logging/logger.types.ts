import type { LoggerService as NestLoggerService } from '@nestjs/common';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'verbose';

export interface LogContext {
  requestId?: string;
  userId?: string;
  tenantId?: string;
  module?: string;
  method?: string;
  durationMs?: number;
  statusCode?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  [key: string]: unknown;
}

export interface ILoggerService extends NestLoggerService {
  error(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  verbose(message: string, context?: LogContext): void;

  log(level: LogLevel, message: string, context?: LogContext): void;
  logError(error: Error, context?: LogContext): void;

  child(bindings: Record<string, unknown>): ILoggerService;
}
