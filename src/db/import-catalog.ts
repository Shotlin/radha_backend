/**
 * Catalog import CLI — populates the consumer browse catalog from Open Food
 * Facts.
 *
 *   pnpm db:import:catalog            # 3 pages per category (default)
 *   IMPORT_PAGES=10 pnpm db:import:catalog
 *   pnpm db:import:catalog 10         # 10 pages per category (argv)
 *
 * Requirements: local infra up (Docker Postgres + Redis) and outbound internet
 * for the OFF API. Bootstraps a standalone Nest application context so the
 * import reuses the real OFF client, mapper, repositories, and health scorer.
 *
 * Idempotent — safe to re-run; products upsert by EAN. `console.*` here is
 * allow-listed for CLI scripts (see the root eslint config).
 */
// MUST be first: preloads .env into process.env before AppModule/ConfigModule
// evaluates (cwd-independent). Run via `ts-node` (not tsx) so Nest DI metadata
// is emitted. See load-cli-env.ts.
import './load-cli-env';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '@/app.module';
import { CatalogImportService } from '@/modules/catalog-import/catalog-import.service';

async function main(): Promise<void> {
  const argPages = process.argv[2];
  const pages = Number.parseInt(process.env.IMPORT_PAGES ?? argPages ?? '3', 10);
  const pagesPerCategory = Number.isFinite(pages) && pages > 0 ? pages : 3;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const importer = app.get(CatalogImportService);
    // eslint-disable-next-line no-console
    console.info(
      `🌱 Importing catalog from Open Food Facts (${pagesPerCategory} pages/category)...`,
    );
    const summary = await importer.run({ pagesPerCategory });
    // eslint-disable-next-line no-console
    console.info('✅ Catalog import complete:', JSON.stringify(summary, null, 2));
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('❌ Catalog import failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
