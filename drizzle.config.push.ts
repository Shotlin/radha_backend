import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Config } from 'drizzle-kit';

// Non-interactive `push:pg` config for the self-hosted native Postgres
// (Ubuntu self-signed TLS). Lives in server/ so __dirname resolves the
// server's .env.<NODE_ENV>. Differences from drizzle.config.ts:
//   - strict: false   → push applies without an interactive confirm prompt
//   - ssl: { rejectUnauthorized: false } → accept the self-signed server cert
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
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  },
  verbose: true,
  strict: false,
} satisfies Config;
