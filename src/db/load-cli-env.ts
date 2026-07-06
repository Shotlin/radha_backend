/**
 * Side-effect module: preload the server's `.env.<NODE_ENV>` (+ `.env`) into
 * `process.env` **before** any AppModule / `@nestjs/config` code evaluates.
 *
 * Why: `ConfigModule.forRoot({ envFilePath })` resolves its env files relative
 * to `process.cwd()`, so a CLI launched from a different working directory
 * boots with no env, `NestConfigService` fails to provide, and the whole Nest
 * context crashes (`Cannot read properties of undefined (reading 'get')`).
 * Resolving from `__dirname` here (the same approach as `migrate.ts`) makes the
 * context-bootstrapping CLIs (`import-catalog`, `import-curated`,
 * `host-catalog-images`) cwd-independent.
 *
 * Import this as the FIRST import in any such CLI:  `import './load-cli-env';`
 * Existing `process.env` values always win, so real CLI overrides aren't
 * clobbered.
 */
// Nest DI reads constructor param types via `design:paramtypes` metadata, which
// requires the `reflect-metadata` polyfill to be loaded before any decorated
// class evaluates. `nest start` / `main.api.ts` import it; a bare tsx CLI does
// not — without it every injected dependency resolves to `undefined` and the
// context crashes. Loading it here (the CLIs' first import) covers them all.
import 'reflect-metadata';

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
