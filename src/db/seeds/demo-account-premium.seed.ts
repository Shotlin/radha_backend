import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postgres from 'postgres';

/**
 * One-shot grant: put the hardcoded business demo account
 * (`9999999999`, see `AuthService.DEMO_MOBILE`) on the top-tier `pro`
 * plan, permanently and at no charge, so demos can exercise every
 * gated feature without hitting a paywall.
 *
 * Idempotent — re-running just re-applies the same plan/period to the
 * same tenant (`ON CONFLICT (tenant_id) DO UPDATE`, the same upsert
 * shape `UpgradeService` itself would produce for a real upgrade).
 *
 * The personal demo number (`8000000000`, `DEMO_MOBILE_PERSONAL`) is
 * deliberately NOT seeded here: consumer-mode accounts have no
 * `tenant_subscriptions` row at all (`tenantId` stays null —
 * `resolveOrCreateUser`'s fresh-consumer path never sets one), the
 * `/subscriptions/*` routes reject the `consumer` role outright
 * (`SubscriptionsController.getStatus`'s `@Roles(...)` list), and the
 * mobile client never calls them for consumer mode — it returns a
 * hardcoded full-feature `_consumerDefaultState` locally
 * (`entitlement_provider.dart`) before any network call. Every
 * consumer account, demo or real, already has unconditional access to
 * every consumer-facing feature; there is no subscription gate to lift.
 *
 * Standalone-friendly, same env-loading convention as
 * `subscription-plans.seed.ts` — no NestJS bootstrap required.
 *
 * `console.info` / `console.error` here are allow-listed by the root
 * `.eslintrc.js` — CLI scripts surface their output via stdout/stderr
 * so the orchestrator can capture progress.
 */

const DEMO_MOBILE_BUSINESS = '9999999999';
const GRANTED_PLAN_CODE = 'pro';
/** Far enough out that the demo account never shows a renewal countdown. */
const PERIOD_YEARS = 100;

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

  try {
    const [user] = await sql<{ tenant_id: string | null }[]>`
      SELECT tenant_id FROM users WHERE mobile = ${DEMO_MOBILE_BUSINESS} LIMIT 1
    `;
    if (!user) {
      console.info(
        `⚠️  No user row for mobile ${DEMO_MOBILE_BUSINESS} yet — log in with the demo OTP once ` +
          `(see AuthService.DEMO_OTP) to materialise the account, then re-run this seed.`,
      );
      return;
    }
    if (!user.tenant_id) {
      console.info(
        `⚠️  User ${DEMO_MOBILE_BUSINESS} exists but has no tenant_id — it hasn't been through ` +
          `business activation yet, so there's no tenant to grant a plan to.`,
      );
      return;
    }

    const [plan] = await sql<{ id: string }[]>`
      SELECT id FROM subscription_plans WHERE code = ${GRANTED_PLAN_CODE} LIMIT 1
    `;
    if (!plan) {
      console.info(
        `⚠️  No subscription_plans row for code='${GRANTED_PLAN_CODE}' — run ` +
          `'pnpm db:seed:plans' first.`,
      );
      return;
    }

    const periodStart = new Date();
    const periodEnd = new Date(periodStart);
    periodEnd.setFullYear(periodEnd.getFullYear() + PERIOD_YEARS);

    await sql`
      INSERT INTO tenant_subscriptions
        (tenant_id, plan_id, plan_code, status, current_period_start,
         current_period_end, monthly_amount, payment_method, metadata)
      VALUES
        (${user.tenant_id}, ${plan.id}, ${GRANTED_PLAN_CODE}, 'active',
         ${periodStart}, ${periodEnd}, '0', 'demo_grant',
         ${sql.json({ grantedBy: 'demo-account-premium.seed', reason: 'permanent demo access', mobile: DEMO_MOBILE_BUSINESS })})
      ON CONFLICT (tenant_id) DO UPDATE SET
        plan_id = EXCLUDED.plan_id,
        plan_code = EXCLUDED.plan_code,
        status = 'active',
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        monthly_amount = EXCLUDED.monthly_amount,
        payment_method = EXCLUDED.payment_method,
        cancelled_at = NULL,
        cancellation_reason = NULL,
        pending_plan_id = NULL,
        pending_plan_code = NULL,
        metadata = EXCLUDED.metadata,
        updated_at = now()
    `;

    console.info(
      `✅ Tenant ${user.tenant_id} (mobile ${DEMO_MOBILE_BUSINESS}) granted '${GRANTED_PLAN_CODE}' ` +
        `through ${periodEnd.toISOString().slice(0, 10)}.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error('❌ Demo account premium grant failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
