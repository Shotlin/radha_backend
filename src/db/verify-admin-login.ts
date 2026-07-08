/**
 * One-off, self-contained verification: generates a FRESH password,
 * rotates the given admin's credential to it, then calls
 * `AdminAuthService.login()` directly in-process (no HTTP, no shell
 * echoing of the plaintext anywhere) to prove the real backend's
 * admin-login path (bcrypt verify + JWT issue) works end-to-end.
 * Never prints the password. Reports PASS/FAIL + non-sensitive fields.
 *
 * Usage: pnpm exec ts-node -r tsconfig-paths/register src/db/verify-admin-login.ts <email>
 */
import './load-cli-env';
import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AdminCredentialsRepository } from '../modules/auth/repositories/admin-credentials.repository';
import { PasswordService } from '../modules/auth/services/password.service';
import { AdminAuthService } from '../modules/auth/services/admin-auth.service';

function generatePassword(): string {
  const raw = randomBytes(18).toString('base64').replace(/[+/=]/g, '');
  return `${raw}!A9`;
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: verify-admin-login.ts <email>');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const credsRepo = app.get(AdminCredentialsRepository);
    const passwords = app.get(PasswordService);
    const adminAuth = app.get(AdminAuthService);

    const cred = await credsRepo.findByEmail(email);
    if (!cred) {
      console.error(`FAIL: no admin credentials for ${email}`);
      process.exit(1);
    }

    const freshPassword = generatePassword();
    const hash = await passwords.hash(freshPassword);
    await credsRepo.updatePasswordHash(cred.id, hash);

    const result = await adminAuth.login(
      { email, password: freshPassword },
      '127.0.0.1',
      'verify-admin-login-script',
    );

    const hasTokens = Boolean(result.accessToken && result.refreshToken);
    console.info(hasTokens ? 'PASS: admin login succeeded' : 'FAIL: login returned no tokens');
    console.info(`  user.id:   ${result.user.id}`);
    console.info(`  user.role: ${result.user.role}`);
    console.info(`  accessToken present: ${Boolean(result.accessToken)}`);
    console.info(`  refreshToken present: ${Boolean(result.refreshToken)}`);
    process.exit(hasTokens ? 0 : 1);
  } catch (err) {
    console.error('FAIL:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await app.close();
  }
}

main();
