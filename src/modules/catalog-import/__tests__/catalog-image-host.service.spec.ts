import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LoggerService } from '@/logging/logger.service';
import { CloudFrontService } from '@/integrations/aws/cloudfront/cloudfront.service';
import type { IS3Service } from '@/integrations/aws/s3/s3.types';
import { ProductsRepository } from '@/modules/products/products.repository';

import { CatalogImageHostService, type CuratedImageInput } from '../catalog-image-host.service';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

interface Mocks {
  s3: jest.Mocked<Pick<IS3Service, 'objectExists' | 'uploadObject'>>;
  cdn: jest.Mocked<Pick<CloudFrontService, 'getCdnUrl'>>;
  products: jest.Mocked<Pick<ProductsRepository, 'updateGlobalImageByEan'>>;
}

const build = (over: Partial<Mocks> = {}): { svc: CatalogImageHostService } & Mocks => {
  const s3 = {
    objectExists: jest.fn().mockResolvedValue(false),
    uploadObject: jest.fn().mockResolvedValue('key'),
    ...over.s3,
  } as Mocks['s3'];
  const cdn = {
    getCdnUrl: jest.fn().mockImplementation((k: string) => `https://cdn.test/${k}`),
    ...over.cdn,
  } as Mocks['cdn'];
  const products = {
    updateGlobalImageByEan: jest.fn().mockResolvedValue({ id: 'p-1' }),
    ...over.products,
  } as Mocks['products'];

  const svc = new CatalogImageHostService(
    s3 as unknown as IS3Service,
    cdn as unknown as CloudFrontService,
    products as unknown as ProductsRepository,
    buildLogger(),
  );
  return { svc, s3, cdn, products };
};

describe('CatalogImageHostService', () => {
  let dir: string;
  let inputs: CuratedImageInput[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'radha-img-'));
    const filePath = join(dir, 'parle-g-biscuits.webp');
    writeFileSync(filePath, Buffer.from([0x52, 0x49, 0x46, 0x46])); // tiny fake webp
    inputs = [{ slug: 'parle-g-biscuits', ean: '8901234567890', filePath }];
  });

  it('uploads the image and points the catalog row at the CDN URL', async () => {
    const { svc, s3, products } = build();

    const summary = await svc.hostAll(inputs);

    expect(s3.uploadObject).toHaveBeenCalledWith(
      'catalog/products/8901234567890.webp',
      expect.any(Buffer),
      'image/webp',
    );
    expect(products.updateGlobalImageByEan).toHaveBeenCalledWith(
      '8901234567890',
      'https://cdn.test/catalog/products/8901234567890.webp',
    );
    expect(summary.uploaded).toBe(1);
    expect(summary.catalogRowsUpdated).toBe(1);
    expect(summary.items[0].status).toBe('hosted');
  });

  it('is idempotent — skips the upload when the object already exists', async () => {
    const { svc, s3, products } = build({
      s3: {
        objectExists: jest.fn().mockResolvedValue(true),
        uploadObject: jest.fn(),
      } as unknown as Mocks['s3'],
    });

    const summary = await svc.hostAll(inputs);

    expect(s3.uploadObject).not.toHaveBeenCalled();
    expect(summary.alreadyPresent).toBe(1);
    // Still refreshes the catalog row's image_url.
    expect(products.updateGlobalImageByEan).toHaveBeenCalled();
    expect(summary.items[0].status).toBe('skipped_exists');
  });

  it('reports (never invents) when no global catalog row exists for the EAN', async () => {
    const { svc, products } = build({
      products: {
        updateGlobalImageByEan: jest.fn().mockResolvedValue(null),
      } as unknown as Mocks['products'],
    });

    const summary = await svc.hostAll(inputs);

    expect(products.updateGlobalImageByEan).toHaveBeenCalled();
    expect(summary.missingCatalogRows).toBe(1);
    expect(summary.catalogRowsUpdated).toBe(0);
    expect(summary.items[0].status).toBe('no_catalog_row');
  });

  it('isolates a failure to one item and continues', async () => {
    const { svc } = build({
      s3: {
        objectExists: jest.fn().mockRejectedValue(new Error('s3 down')),
        uploadObject: jest.fn(),
      } as unknown as Mocks['s3'],
    });

    const summary = await svc.hostAll(inputs);

    expect(summary.errors).toBe(1);
    expect(summary.items[0].status).toBe('error');
  });
});
