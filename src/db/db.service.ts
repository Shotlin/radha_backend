import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';
import { MetricsService } from '@/observability/metrics.service';

import { createDatabaseConnection, DatabaseConnection, DrizzleDb, Transaction } from './connection';
import { IDbService, TransactionOptions } from './db.types';

/**
 * NestJS-managed wrapper around the Drizzle/postgres connection pool.
 *
 *   - Boots the pool in `onModuleInit` and pings the database before
 *     letting the rest of the app come up.
 *   - Exposes `transaction()` with isolation level, read-only mode,
 *     deferrable mode, and a per-transaction statement timeout.
 *   - Tags transaction commits / rollbacks as metrics (BE-04 service)
 *     so we can see write throughput in dashboards.
 *   - Closes cleanly on shutdown so Kubernetes pod termination
 *     doesn't leave half-open connections.
 */
@Injectable()
export class DbService implements IDbService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private connection: DatabaseConnection | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly appLogger: LoggerService,
    private readonly metrics: MetricsService,
  ) {
    // Eagerly create the connection so factories depending on getDb() work
    // during module instantiation. The ping check is deferred to onModuleInit.
    try {
      this.connection = createDatabaseConnection(this.config, this.appLogger);
    } catch (err) {
      this.logger.error('Failed to create database connection in constructor', err as Error);
    }
  }

  async onModuleInit(): Promise<void> {
    try {
      if (!this.connection) {
        this.connection = createDatabaseConnection(this.config, this.appLogger);
      }
      const ok = await this.ping();
      if (!ok) {
        this.logger.warn(
          `Initial DB ping failed (host=${this.config.database.host}, port=${this.config.database.port}, db=${this.config.database.name}). Server will start but DB queries may fail.`,
        );
        // In development, allow the server to start even if DB is temporarily unavailable
        if (!this.config.isDevelopment) {
          throw new Error('Initial DB ping returned false');
        }
        return;
      }
      this.logger.log(
        `Database connected: ${this.config.database.host}:${this.config.database.port}/${this.config.database.name}`,
      );
    } catch (err) {
      this.logger.error('Failed to connect to database', err as Error);
      if (!this.config.isDevelopment) {
        throw new BusinessException(
          ErrorCode.DATABASE_CONNECTION_FAILED,
          'Failed to establish database connection',
          { metadata: { cause: (err as Error).message } },
        );
      }
      this.logger.warn('Continuing despite DB connection failure (development mode)');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connection) {
      await this.connection.close(5);
      this.connection = null;
    }
  }

  getDb(): DrizzleDb {
    if (!this.connection) {
      throw new BusinessException(ErrorCode.DATABASE_CONNECTION_FAILED, 'Database not initialised');
    }
    return this.connection.db;
  }

  async ping(): Promise<boolean> {
    if (!this.connection) return false;
    try {
      await this.connection.db.execute(sql`SELECT 1`);
      return true;
    } catch (err) {
      this.appLogger.error('database.ping.failed', {
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return false;
    }
  }

  async transaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await this.getDb().transaction(async (tx) => {
        if (options?.isolationLevel) {
          await tx.execute(
            sql.raw(`SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}`),
          );
        }
        if (options?.readOnly) {
          await tx.execute(sql`SET TRANSACTION READ ONLY`);
        }
        if (options?.deferrable) {
          await tx.execute(sql`SET TRANSACTION DEFERRABLE`);
        }
        if (options?.timeoutMs && options.timeoutMs > 0) {
          await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${options.timeoutMs}`));
        }
        return callback(tx);
      });
      this.metrics.counter('db.transaction.committed', 1);
      this.metrics.histogram('db.transaction.duration_ms', Date.now() - start);
      return result;
    } catch (err) {
      this.metrics.counter('db.transaction.rolled_back', 1);
      this.appLogger.error('database.transaction.rollback', {
        error: { name: (err as Error).name, message: (err as Error).message },
        durationMs: Date.now() - start,
      });
      throw this.translateError(err);
    }
  }

  async close(timeoutSeconds = 5): Promise<void> {
    if (this.connection) {
      await this.connection.close(timeoutSeconds);
      this.connection = null;
    }
  }

  /**
   * Convert raw `postgres-js` errors into typed BusinessException so
   * the global filter renders the standard envelope and Sentry sees
   * a known code.
   */
  private translateError(err: unknown): unknown {
    if (err instanceof BusinessException) return err;
    if (err instanceof Error) {
      const code = (err as Error & { code?: string }).code;
      if (code === '57014' /* statement_timeout */) {
        return new BusinessException(ErrorCode.DATABASE_TIMEOUT, 'Database query timed out', {
          metadata: { cause: err.message },
        });
      }
      if (code === '40P01' /* deadlock_detected */) {
        return new BusinessException(ErrorCode.DATABASE_DEADLOCK, 'Database deadlock detected', {
          metadata: { cause: err.message },
        });
      }
      return new BusinessException(ErrorCode.DATABASE_QUERY_FAILED, err.message, {
        metadata: { code: code ?? null },
      });
    }
    return err;
  }
}
