import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * drizzle-kit is a CLI that runs *outside* the NestJS application
 * context, so we cannot reuse the typed `ConfigService` here. We load
 * `.env.<NODE_ENV>` directly with a tiny in-process parser so
 * `pnpm db:push` / `pnpm db:generate` / `pnpm db:studio` all see the
 * same DB credentials as the runtime.
 *
 * Production deploys never run drizzle-kit; migrations are applied via
 * `pnpm db:migrate` (which uses the same env values).
 *
 * Note: drizzle-kit 0.20.x requires `driver: 'pg'` config form. The
 * `dialect: 'postgresql'` form was introduced in 0.21 and is not
 * understood by 0.20.18 (the version pinned here).
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
loadEnvFile(resolve(__dirname, `.env.${nodeEnv}`));
loadEnvFile(resolve(__dirname, '.env'));

export default {
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  driver: 'pg',
  dbCredentials: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'radha_dev',
    ssl: process.env.DB_SSL === 'true',
  },
  verbose: true,
  strict: true,
} satisfies Config;
