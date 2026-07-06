import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postgres from 'postgres';

import { DEFAULT_PLANS } from '@/modules/subscriptions/constants/default-plans';

/**
 * BE-28 — One-shot seed for the default plan catalog.
 *
 * Reads `DEFAULT_PLANS` (the canonical list of trial / starter /
 * growth / pro) and upserts both `subscription_plans` and
 * `plan_entitlements`. Idempotent: re-running the script preserves
 * existing plan ids so tenant subscriptions stay linked.
 *
 * Run via the orchestrator-added `pnpm db:seed:plans` script. Never
 * inlined into the migration so plan tweaks (price, limit, naming)
 * can ship without a fresh migration.
 *
 * Standalone-friendly — pulls DB credentials from the same .env
 * loader used by `drizzle.config.ts`. No NestJS bootstrap required.
 *
 * `console.info` / `console.error` here are allow-listed by the root
 * `.eslintrc.js` — CLI scripts surface their output via stdout/stderr
 * so the orchestrator can capture progress.
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

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  loadEnvFile(resolve(__dirname, '..', '..', '..', `.env.${nodeEnv}`));
  loadEnvFile(resolve(__dirname, '..', '..', '..', '.env'));

  const sql = postgres({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'radha_dev',
    ssl: process.env.DB_SSL === 'true',
    max: 4,
  });

  let upsertedPlans = 0;
  let upsertedEntitlements = 0;

  try {
    for (const plan of DEFAULT_PLANS) {
      const [planRow] = await sql<{ id: string }[]>`
        INSERT INTO subscription_plans
          (code, name, description, price, currency, trial_days,
           is_public, is_active, sort_order, metadata)
        VALUES
          (${plan.code}, ${plan.name}, ${plan.description}, ${plan.price},
           'INR', ${plan.trialDays}, ${plan.isPublic}, ${plan.isActive},
           ${plan.sortOrder}, '{}'::jsonb)
        ON CONFLICT (code) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          price = EXCLUDED.price,
          trial_days = EXCLUDED.trial_days,
          is_public = EXCLUDED.is_public,
          is_active = EXCLUDED.is_active,
          sort_order = EXCLUDED.sort_order,
          updated_at = now()
        RETURNING id
      `;
      const planId = planRow.id;
      upsertedPlans += 1;

      for (const f of plan.features) {
        const isUnlimited = f.limit === 'unlimited';
        const limitValue = isUnlimited ? null : Number(f.limit);
        await sql`
          INSERT INTO plan_entitlements
            (plan_id, feature, limit_value, is_unlimited, description, metadata)
          VALUES
            (${planId}, ${f.feature}, ${limitValue}, ${isUnlimited},
             ${f.description}, '{}'::jsonb)
          ON CONFLICT (plan_id, feature) DO UPDATE SET
            limit_value = EXCLUDED.limit_value,
            is_unlimited = EXCLUDED.is_unlimited,
            description = EXCLUDED.description,
            updated_at = now()
        `;
        upsertedEntitlements += 1;
      }
    }

    console.info(
      `🌱 BE-28 plans seeded: ${upsertedPlans} plans, ${upsertedEntitlements} entitlements upserted.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error('❌ BE-28 plans seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
