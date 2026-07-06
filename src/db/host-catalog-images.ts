/**
 * Catalog image-host CLI (Phase 3) — uploads the curated product pack-shots to
 * S3 + CloudFront and points the seeded global catalog rows at the CDN URL.
 *
 *   pnpm db:host:images
 *
 * Prerequisites:
 *   1. The curated seed has run (`pnpm db:import:curated`), producing
 *      `server/.tmp/curated-eans.json` (the slug → real-EAN map) and the
 *      global catalog rows those EANs key.
 *   2. AWS credentials are configured (else the AWS layer resolves to the
 *      in-memory mock and nothing is actually hosted — harmless no-op).
 *
 * Image source: the bundled Flutter pack-shots at
 * `apps/mobile/assets/v2/products/<slug>.webp` — the same art the app ships,
 * so the hosted catalog image matches the offline launch image exactly.
 *
 * Idempotent: skips S3 uploads for objects that already exist and overwrites
 * `image_url` deterministically. `console.*` is allow-listed for CLI scripts.
 */
// MUST be first: preloads .env into process.env before AppModule/ConfigModule
// evaluates (cwd-independent). Run via `ts-node` (not tsx) so Nest DI metadata
// is emitted. See load-cli-env.ts.
import './load-cli-env';

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '@/app.module';
import {
  CatalogImageHostService,
  type CuratedImageInput,
} from '@/modules/catalog-import/catalog-image-host.service';

const PRODUCTS_ASSET_DIR = resolve(
  process.cwd(),
  '..',
  'apps',
  'mobile',
  'assets',
  'v2',
  'products',
);

function loadResolvedEans(): Record<string, string> {
  const path = resolve(process.cwd(), '.tmp', 'curated-eans.json');
  if (!existsSync(path)) {
    throw new Error(`Resolved EAN map not found at ${path}. Run "pnpm db:import:curated" first.`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    resolved?: Record<string, string>;
  };
  return raw.resolved ?? {};
}

function buildInputs(resolved: Record<string, string>): CuratedImageInput[] {
  const inputs: CuratedImageInput[] = [];
  for (const [slug, ean] of Object.entries(resolved)) {
    const filePath = resolve(PRODUCTS_ASSET_DIR, `${slug}.webp`);
    if (!existsSync(filePath)) {
      // eslint-disable-next-line no-console
      console.warn(`⚠ No bundled image for slug "${slug}" at ${filePath} — skipping.`);
      continue;
    }
    inputs.push({ slug, ean, filePath });
  }
  return inputs;
}

async function main(): Promise<void> {
  const resolved = loadResolvedEans();
  const inputs = buildInputs(resolved);

  if (inputs.length === 0) {
    // eslint-disable-next-line no-console
    console.info('Nothing to host — no resolved EANs with a matching bundled image.');
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const host = app.get(CatalogImageHostService);
    // eslint-disable-next-line no-console
    console.info(`🖼  Hosting ${inputs.length} curated catalog image(s) on S3 + CloudFront...`);
    const summary = await host.hostAll(inputs);
    // eslint-disable-next-line no-console
    console.info('✅ Image host complete:', JSON.stringify(summary, null, 2));
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('❌ Image host failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
