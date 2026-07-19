/**
 * One-off: create the "Radha Store" business admin account
 * (mobile `9724710944`, one of the hardcoded demo-OTP numbers in
 * `AuthService.DEMO_ACCOUNTS`) and grant it the top-tier `pro` plan
 * for 1 year, at no charge — founder-requested demo/admin account,
 * 2026-07-19.
 *
 * Reuses the real `TenantOnboardingService` (same path `POST
 * /tenants/onboard` uses) rather than hand-rolling tenant/user/store
 * inserts, same reasoning as `create-first-admin.ts`. The subscription
 * grant mirrors `demo-account-premium.seed.ts`'s upsert shape.
 *
 * Idempotent: if the mobile already has a user row, onboarding is
 * skipped and only the subscription grant (also idempotent, ON
 * CONFLICT DO UPDATE) is (re-)applied.
 *
 * Run via `ts-node` (not `tsx`) so Nest DI metadata is emitted, same
 * as `create-first-admin.ts`.
 *
 * Usage: pnpm exec ts-node -r tsconfig-paths/register src/db/create-radha-store-account.ts
 */
import './load-cli-env';
import { eq } from 'drizzle-orm';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { UsersRepository } from '../modules/auth/repositories/users.repository';
import { TenantOnboardingService } from '../modules/tenants/services/tenant-onboarding.service';
import { DbService } from './db.service';
import { subscriptionPlans } from './schema/subscription-plans';
import { tenantSubscriptions } from './schema/tenant-subscriptions';

const MOBILE = '9724710944';
const BUSINESS_NAME = 'Radha Store';
const SUBDOMAIN = 'radha-store';
const OWNER_NAME = 'Radha Store Admin';
const OWNER_EMAIL = 'radhastore.admin@opslin.com';
const PLAN_CODE = 'pro';
const PERIOD_YEARS = 1;

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const usersRepo = app.get(UsersRepository);
    const onboarding = app.get(TenantOnboardingService);
    const db = app.get(DbService).getDb();

    let tenantId: string | null | undefined;

    const existing = await usersRepo.findByMobile(MOBILE);
    if (existing) {
      tenantId = existing.tenantId;
      console.info(
        `ℹ️  User already exists for mobile ${MOBILE} (id ${existing.id}, tenant ${tenantId ?? 'none'}) — skipping onboarding.`,
      );
      if (!tenantId) {
        console.error(
          `❌ Existing user has no tenant_id — can't grant a plan. Investigate before re-running.`,
        );
        process.exit(1);
      }
    } else {
      const result = await onboarding.onboard({
        businessName: BUSINESS_NAME,
        subdomain: SUBDOMAIN,
        industry: 'Grocery',
        ownerName: OWNER_NAME,
        email: OWNER_EMAIL,
        mobile: MOBILE,
        storeName: BUSINESS_NAME,
        country: 'IN',
      });
      tenantId = result.tenant.id;
      console.info(
        `✅ Onboarded tenant ${tenantId} — owner ${result.owner.id}, store ${result.store.id} ('${result.store.name}').`,
      );
    }

    const [plan] = await db
      .select({ id: subscriptionPlans.id })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.code, PLAN_CODE))
      .limit(1);
    if (!plan) {
      console.error(`❌ No subscription_plans row for code='${PLAN_CODE}' — run 'pnpm db:seed:plans' first.`);
      process.exit(1);
    }

    const periodStart = new Date();
    const periodEnd = new Date(periodStart);
    periodEnd.setFullYear(periodEnd.getFullYear() + PERIOD_YEARS);

    await db
      .insert(tenantSubscriptions)
      .values({
        tenantId: tenantId!,
        planId: plan.id,
        planCode: PLAN_CODE,
        status: 'active',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        monthlyAmount: '0',
        paymentMethod: 'demo_grant',
        metadata: { grantedBy: 'create-radha-store-account', reason: 'founder-requested admin account', mobile: MOBILE },
      })
      .onConflictDoUpdate({
        target: tenantSubscriptions.tenantId,
        set: {
          planId: plan.id,
          planCode: PLAN_CODE,
          status: 'active',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          monthlyAmount: '0',
          paymentMethod: 'demo_grant',
          cancelledAt: null,
          cancellationReason: null,
          pendingPlanId: null,
          pendingPlanCode: null,
          updatedAt: new Date(),
        },
      });

    console.info(
      `✅ Tenant ${tenantId} (mobile ${MOBILE}) granted '${PLAN_CODE}' through ${periodEnd.toISOString().slice(0, 10)}.`,
    );
    console.info(`   Log in on the mobile app with ${MOBILE} / OTP 123456.`);
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('create-radha-store-account failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
