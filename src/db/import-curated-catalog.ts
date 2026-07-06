/**
 * Curated catalog seed CLI — resolves real EANs for the 29 hand-picked launch
 * products (the mobile `launch_catalog.dart` spine) from Open Food Facts and
 * seeds them into the global catalog with real nutrition + health scores.
 *
 *   pnpm db:import:curated
 *
 * Honesty: no barcode is ever fabricated. Products OFF can't confidently
 * resolve are reported `unresolved` and skipped (the app shows an honest
 * "scan to unlock" state for them). Idempotent — safe to re-run.
 *
 * Side effect: writes the resolved slug → EAN map to
 * `server/.tmp/curated-eans.json` so the mobile manifest
 * (`apps/mobile/lib/features/catalog/data/launch_catalog.dart`) can be updated
 * with the real barcodes. `console.*` is allow-listed for CLI scripts.
 *
 * Requirements: local infra up (Docker Postgres + Redis) and outbound internet
 * for the OFF API.
 */
// MUST be first: preloads .env into process.env before AppModule/ConfigModule
// evaluates (the Nest context is cwd-sensitive otherwise). See load-cli-env.ts.
import './load-cli-env';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '@/app.module';
import { CatalogImportService } from '@/modules/catalog-import/catalog-import.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const importer = app.get(CatalogImportService);
    // eslint-disable-next-line no-console
    console.info('🌱 Seeding curated launch catalog from Open Food Facts...');
    const summary = await importer.importCurated();

    const resolved = summary.items
      .filter((i) => i.status === 'seeded' && i.resolvedEan)
      .reduce<Record<string, string>>((acc, i) => {
        acc[i.slug] = i.resolvedEan as string;
        return acc;
      }, {});

    const outPath = resolve(process.cwd(), '.tmp', 'curated-eans.json');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ resolved, summary }, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.info('✅ Curated seed complete:', JSON.stringify(summary, null, 2));
    // eslint-disable-next-line no-console
    console.info(`📝 Resolved slug→EAN map written to ${outPath}`);
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('❌ Curated seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
