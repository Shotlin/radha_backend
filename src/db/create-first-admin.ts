/**
 * One-off: create the first dashboard admin account (email/password).
 *
 * There's no bootstrap path for the very first admin otherwise --
 * `POST /auth/admin/invitations` requires an existing admin to send the
 * invite. Run via `ts-node` (not `tsx`) so Nest DI metadata is emitted,
 * same as `import-catalog.ts` -- uses the REAL `PasswordService` (bcrypt
 * cost 12, matching login's own hashing) and repositories rather than
 * hand-rolling a hash or raw SQL.
 *
 * Usage: pnpm exec ts-node -r tsconfig-paths/register src/db/create-first-admin.ts <email> <name>
 * Prints the generated password ONCE -- it is not stored anywhere in
 * plaintext. Change it after first login via Settings > Change Password.
 */
import './load-cli-env';
import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { UsersRepository } from '../modules/auth/repositories/users.repository';
import { AdminCredentialsRepository } from '../modules/auth/repositories/admin-credentials.repository';
import { PasswordService } from '../modules/auth/services/password.service';

function generatePassword(): string {
  // 24 chars, base64url-ish alphabet -- comfortably clears the app's own
  // password policy (length + upper/lower/digit/symbol checks).
  const raw = randomBytes(18).toString('base64').replace(/[+/=]/g, '');
  return `${raw}!A9`;
}

async function main(): Promise<void> {
  const email = process.argv[2];
  const name = process.argv[3] ?? 'Admin';
  if (!email) {
    console.error('Usage: create-first-admin.ts <email> <name>');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const usersRepo = app.get(UsersRepository);
    const credsRepo = app.get(AdminCredentialsRepository);
    const passwords = app.get(PasswordService);

    const existing = await credsRepo.findByEmail(email);
    if (existing) {
      console.error(`Admin credentials already exist for ${email}`);
      process.exit(1);
    }

    const user = await usersRepo.create({
      mobile: `admin-${Date.now()}`, // placeholder -- admin auth never uses OTP/mobile
      email,
      name,
      role: 'admin',
      isVerified: true,
      isActive: true,
    });

    const password = generatePassword();
    const passwordHash = await passwords.hash(password);

    await credsRepo.create({
      userId: user.id,
      email: email.toLowerCase(),
      passwordHash,
      emailVerifiedAt: new Date(),
    });

    console.info('Admin account created:');
    console.info(`  email:    ${email}`);
    console.info(`  password: ${password}`);
    console.info('Change this password after first login (Settings > Change Password).');
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('create-first-admin failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
