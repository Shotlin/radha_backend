/**
 * One-off development bootstrap for a business owner who can use the
 * mobile app's Developer Business Login button.
 *
 * Usage:
 *   pnpm exec ts-node -r tsconfig-paths/register \
 *     src/db/create-radha-developer-account.ts <email> <password> [name]
 *
 * The password is hashed immediately and never written to a file or log.
 * Re-running with the same email is intentionally refused.
 */
import './load-cli-env';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AdminCredentialsRepository } from '../modules/auth/repositories/admin-credentials.repository';
import { PasswordService } from '../modules/auth/services/password.service';
import { TenantOnboardingService } from '../modules/tenants/services/tenant-onboarding.service';

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  const password = process.argv[3];
  const name = process.argv[4]?.trim() || 'RADHA Developer';
  if (!email || !password) {
    throw new Error('Usage: create-radha-developer-account.ts <email> <password> [name]');
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const credentials = app.get(AdminCredentialsRepository);
    if (await credentials.findByEmail(email)) {
      throw new Error(`Credentials already exist for ${email}`);
    }

    const onboarding = app.get(TenantOnboardingService);
    const result = await onboarding.onboard({
      businessName: 'RADHA Developer Store',
      subdomain: `dev-${Date.now()}`,
      industry: 'Grocery',
      ownerName: name,
      email,
      mobile: `dev-${Date.now()}`,
      storeName: 'RADHA Developer Store',
      country: 'IN',
    });

    const passwordService = app.get(PasswordService);
    await credentials.create({
      userId: result.owner.id,
      email,
      passwordHash: await passwordService.hash(password),
      emailVerifiedAt: new Date(),
    });
    console.info(`Created RADHA business developer account ${email} for tenant ${result.tenant.id}.`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('create-radha-developer-account failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
