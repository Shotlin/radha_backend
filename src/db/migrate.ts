/**
 * Standalone migration runner.
 *
 * Reads hand-written SQL files from `src/db/migrations/` in
 * lexicographic order and applies any that haven't already been
 * recorded in `_radha_migrations`. Each file is executed as a single
 * `sql.unsafe(body)` call so multi-statement files work as written.
 *
 * Invoked via `pnpm db:migrate`. Loads connection details from the
 * matching `.env.<NODE_ENV>` file (default: `.env.development`) so the
 * runner doesn't depend on the Nest config module bootstrapping. The
 * env-file parser is intentionally tiny — no external dotenv dep.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import postgres from 'postgres';

const MIGRATIONS_DIR = join(__dirname, 'migrations');
const TABLE = '_radha_migrations';

/**
 * Tiny .env loader. Skips comments and blank lines, supports
 * KEY=VALUE with optional surrounding quotes. Existing
 * `process.env` values win so CLI overrides aren't clobbered.
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const body = readFileSync(path, 'utf8');
  for (const rawLine of body.split(/\r?\n/)) {
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
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const serverRoot = resolve(__dirname, '..', '..');
loadEnvFile(join(serverRoot, `.env.${nodeEnv}`));
loadEnvFile(join(serverRoot, '.env'));

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const sql = url
    ? postgres(url, { max: 1, onnotice: () => undefined })
    : postgres({
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
    `[migrate] connecting to ${process.env.DB_USER ?? 'postgres'}@${
      process.env.DB_HOST ?? 'localhost'
    }:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'radha_dev'}`,
  );

  await sql`CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedRows = await sql<{ id: string }[]>`SELECT id FROM ${sql(TABLE)}`;
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const file of files) {
    if (applied.has(file)) {
      // eslint-disable-next-line no-console
      console.info(`[skip] ${file}`);
      continue;
    }
    const body = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // eslint-disable-next-line no-console
    console.info(`[apply] ${file}`);
    await sql.unsafe(body);
    await sql`INSERT INTO ${sql(TABLE)} (id) VALUES (${file})`;
  }

  await sql.end();
  // eslint-disable-next-line no-console
  console.info('Migrations applied');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err);
  process.exit(1);
});
