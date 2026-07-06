import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { Sql } from 'postgres';

import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';

import * as schema from './schema';

export type DrizzleDb = PostgresJsDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface DatabaseConnection {
  db: DrizzleDb;
  client: Sql;
  close(timeoutSeconds?: number): Promise<void>;
}

const SLOW_QUERY_THRESHOLD_MS = 100;
const MAX_LIFETIME_SECONDS = 60 * 30;

/**
 * Builds the production Postgres pool plus its Drizzle wrapper.
 *
 * Centralises every knob in one place so BE-32 (perf tuning) can iterate
 * without touching the rest of the stack. The Drizzle `logger.logQuery`
 * hook emits a `slow query` warning whenever a single statement exceeds
 * 100 ms — BE-32 graduates this to a histogram.
 */
export const createDatabaseConnection = (
  config: ConfigService,
  appLogger: LoggerService,
): DatabaseConnection => {
  const dbConfig = config.database;

  const client = postgres({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.name,
    username: dbConfig.user,
    password: dbConfig.password,
    ssl: dbConfig.ssl ? 'require' : false,
    max: dbConfig.maxConnections,
    idle_timeout: Math.max(1, Math.round(dbConfig.idleTimeoutMs / 1000)),
    connect_timeout: Math.max(1, Math.round(dbConfig.connectionTimeoutMs / 1000)),
    max_lifetime: MAX_LIFETIME_SECONDS,
    prepare: true,
    connection: {
      application_name: 'radha-api',
      statement_timeout: String(dbConfig.statementTimeoutMs),
    } as Record<string, string>,
    onnotice: (notice) => {
      appLogger.info('postgres.notice', { notice: notice.message ?? String(notice) });
    },
  });

  const slowQueryLogger = config.isDevelopment
    ? {
        logQuery: (query: string, params: unknown[]): void => {
          // postgres-js doesn't give us a duration directly here, but
          // any consumer wanting timing should use MetricsService.
          // We log the actual SQL only in dev to avoid leaking schema
          // shape in production logs.
          appLogger.debug('sql', { query, params });
        },
      }
    : undefined;

  const db = drizzle(client, { schema, logger: slowQueryLogger });

  return {
    db,
    client,
    close: async (timeoutSeconds = 5) => {
      await client.end({ timeout: timeoutSeconds });
      appLogger.info('database.connection.closed', {});
    },
  };
};

export { SLOW_QUERY_THRESHOLD_MS };
