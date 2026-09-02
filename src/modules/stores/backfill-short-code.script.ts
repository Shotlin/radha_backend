/**
 * One-off backfill: assigns a `short_code` to every existing `stores` row
 * left null by migration `0045_stores_short_code.sql` (every store created
 * before this change). Run once, after that migration has applied, via
 * `pnpm db:backfill:store-codes` (invoked with `tsx`, same style as
 * `src/db/migrate.ts` / `batch-dates/backfill.script.ts` — no Nest DI
 * needed for a straight read-generate-write job).
 *
 * Safe to re-run: only rows where `short_code IS NULL` are touched, so a
 * second run (e.g. after a partial failure) just finds nothing left to do.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '@/db/schema';

import { generateStoreCode } from './utils/store-code.util';

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const body = readFileSync(path, 'utf8');
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
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
const serverRoot = resolve(__dirname, '..', '..', '..');
loadEnvFile(join(serverRoot, `.env.${nodeEnv}`));
loadEnvFile(join(serverRoot, '.env'));

const MAX_ATTEMPTS_PER_ROW = 5;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const sql = url
    ? postgres(url, { max: 4, onnotice: () => undefined })
    : postgres({
        host: process.env.DB_HOST ?? 'localhost',
        port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
        database: process.env.DB_NAME ?? 'radha_dev',
        username: process.env.DB_USER ?? 'postgres',
        password: process.env.DB_PASSWORD ?? '',
        ssl: process.env.DB_SSL === 'true' ? 'require' : false,
        max: 4,
        onnotice: () => undefined,
      });
  const db = drizzle(sql, { schema });

  console.info('[backfill] scanning stores with no short_code...');
  const rows = await db
    .select({ id: schema.stores.id })
    .from(schema.stores)
    .where(isNull(schema.stores.shortCode));
  console.info(`[backfill] ${rows.length} store(s) need a short_code`);

  let assigned = 0;
  let failed = 0;

  for (const row of rows) {
    let done = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ROW && !done; attempt += 1) {
      const candidate = generateStoreCode();
      const [existing] = await db
        .select({ id: schema.stores.id })
        .from(schema.stores)
        .where(eq(schema.stores.shortCode, candidate))
        .limit(1);
      if (existing) continue; // collision, re-roll

      await db
        .update(schema.stores)
        .set({ shortCode: candidate })
        .where(eq(schema.stores.id, row.id));
      done = true;
      assigned++;
    }
    if (!done) {
      failed++;
      console.error(`[backfill] gave up on store ${row.id} after ${MAX_ATTEMPTS_PER_ROW} attempts`);
    }
  }

  console.info(`[backfill] assigned ${assigned} short_code(s), ${failed} failure(s)`);
  await sql.end();
  console.info('[backfill] done');
}

main().catch((err: unknown) => {
  console.error('[backfill] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
