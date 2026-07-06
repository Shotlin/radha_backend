/**
 * Drops the entire `public` schema and recreates it.
 *
 * Use this only against the local Docker Postgres. Hard-aborts if
 * `NODE_ENV` is `production` or `staging`. After running, re-run
 * `pnpm db:push && pnpm db:migrate` to rebuild the schema from
 * scratch.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postgres from 'postgres';

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
const serverRoot = resolve(__dirname, '..', '..');
loadEnvFile(resolve(serverRoot, `.env.${nodeEnv}`));
loadEnvFile(resolve(serverRoot, '.env'));

if (nodeEnv === 'production' || nodeEnv === 'staging') {
  // eslint-disable-next-line no-console
  console.error(`[db:reset] refusing to reset ${nodeEnv} environment`);
  process.exit(1);
}

async function main(): Promise<void> {
  const sql = postgres({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME ?? 'radha_dev',
    username: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
    ssl: process.env.DB_SSL === 'true' ? 'require' : false,
    max: 1,
    onnotice: () => undefined,
  });

  // eslint-disable-next-line no-console
  console.info(
    `[db:reset] dropping public schema in ${process.env.DB_NAME}@${process.env.DB_HOST}:${process.env.DB_PORT}`,
  );
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await sql.end();
  // eslint-disable-next-line no-console
  console.info('[db:reset] done. Run `pnpm db:push && pnpm db:migrate` next.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[db:reset] failed:', err);
  process.exit(1);
});
