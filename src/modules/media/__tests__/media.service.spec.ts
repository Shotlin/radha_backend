import {
  BusinessException,
  DomainNotFoundException,
  ValidationException,
} from '@/common/errors/business.exception';
import { ConfigService } from '@/config/config.service';
import { CloudFrontService } from '@/integrations/aws/cloudfront/cloudfront.service';
import { MockS3Service } from '@/integrations/aws/s3/mock-s3.service';
import { LoggerService } from '@/logging/logger.service';

import type { MediaAssetRow } from '@/db/schema/media-assets';

import { MediaRepository } from '../media.repository';
import { MediaService } from '../media.service';
import { ImageProcessorService } from '../services/image-processor.service';
import { ImageValidatorService } from '../services/image-validator.service';

const JPEG_MAGIC = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
// Pad above MEDIA_MIN_BYTES (100) so the buffer-size validator accepts it
// while preserving the JPEG magic prefix used for content-type sniffing.
const JPEG_BUFFER = Buffer.concat([JPEG_MAGIC, Buffer.alloc(256)]);

const buildConfig = (): ConfigService =>
  ({
    aws: {
      region: 'ap-south-1',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
      s3: {
        bucket: 'radha-test',
        region: 'ap-south-1',
        presignedUrlExpirySeconds: 600,
      },
      cloudfront: { domain: 'cdn.example.com' },
    },
  }) as unknown as ConfigService;

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildRepo = (
  rows: Map<string, MediaAssetRow> = new Map(),
): {
  repo: MediaRepository;
  rows: Map<string, MediaAssetRow>;
} => {
  const repo = {
    create: jest.fn(async (data: Partial<MediaAssetRow> & { id: string }) => {
      const row = {
        id: data.id,
        tenantId: data.tenantId ?? null,
        ownerType: data.ownerType,
        ownerId: data.ownerId ?? null,
        s3Bucket: data.s3Bucket,
        s3Key: data.s3Key,
        contentType: data.contentType,
        contentLength: data.contentLength,
        status: data.status ?? 'pending',
        variants: {},
        width: null,
        height: null,
        sourceUrl: data.sourceUrl ?? null,
        uploadedAt: data.uploadedAt ?? null,
        processedAt: data.processedAt ?? null,
        uploadedBy: data.uploadedBy ?? null,
        metadata: data.metadata ?? {},
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        createdBy: null,
        updatedBy: null,
        deletedBy: null,
      } as unknown as MediaAssetRow;
      rows.set(row.id, row);
      return row;
    }),
    findVisibleById: jest.fn(async (id: string) => rows.get(id) ?? null),
    findByOwner: jest.fn(async () => Array.from(rows.values())),
    update: jest.fn(async (id: string, data: Partial<MediaAssetRow>) => {
      const existing = rows.get(id);
      if (!existing) throw new Error('not found');
      const next = { ...existing, ...data, updatedAt: new Date() } as MediaAssetRow;
      rows.set(id, next);
      return next;
    }),
    markStatus: jest.fn(async (id: string, status: MediaAssetRow['status']) => {
      const existing = rows.get(id);
      if (!existing) throw new Error('not found');
      const next = { ...existing, status } as MediaAssetRow;
      rows.set(id, next);
      return next;
    }),
    softDelete: jest.fn(async (id: string) => {
      const existing = rows.get(id);
      if (existing) rows.set(id, { ...existing, deletedAt: new Date() });
    }),
  } as unknown as MediaRepository;
  return { repo, rows };
};

const buildService = (
  rowsSeed?: Map<string, MediaAssetRow>,
): {
  svc: MediaService;
  s3: MockS3Service;
  rows: Map<string, MediaAssetRow>;
  repo: MediaRepository;
} => {
  const config = buildConfig();
  const logger = buildLogger();
  const s3 = new MockS3Service();
  const cdn = new CloudFrontService(config);
  const validator = new ImageValidatorService();
  const { repo, rows } = buildRepo(rowsSeed);
  // Stub processor — confirmUpload triggers it fire-and-forget; we
  // resolve immediately so the test never observes the side effect.
  const processor = {
    processImage: jest.fn(async (id: string) => ({
      mediaId: id,
      variants: {} as never,
      totalSizeBytes: 0,
      optimizationRatio: 1,
      durationMs: 0,
    })),
    buildVariantManifest: jest.fn(() => null),
  } as unknown as ImageProcessorService;
  const svc = new MediaService(config, logger, s3, cdn, repo, validator, processor);
  return { svc, s3, rows, repo };
};

describe('MediaService.initiateUpload', () => {
  it('returns a presigned URL and persists a pending row', async () => {
    const { svc, rows } = buildService();
    const result = await svc.initiateUpload(
      {
        ownerType: 'product',
        ownerId: '11111111-1111-1111-1111-111111111111',
        contentType: 'image/jpeg',
        contentLength: 4096,
      },
      'user-1',
      'tenant-1',
    );
    expect(result.uploadUrl).toContain('/_mock-s3/upload/');
    expect(result.expiresIn).toBe(600);
    expect(result.cdnUrl).toContain('cdn.example.com');
    expect(rows.size).toBe(1);
    const row = rows.values().next().value!;
    expect(row.status).toBe('pending');
    expect(row.tenantId).toBe('tenant-1');
  });

  it('rejects unsupported content types', async () => {
    const { svc } = buildService();
    await expect(
      svc.initiateUpload(
        { ownerType: 'product', contentType: 'application/exe' as never, contentLength: 1024 },
        'user-1',
        'tenant-1',
      ),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('rejects oversized requests', async () => {
    const { svc } = buildService();
    await expect(
      svc.initiateUpload(
        { ownerType: 'product', contentType: 'image/jpeg', contentLength: 50 * 1024 * 1024 },
        'user-1',
        'tenant-1',
      ),
    ).rejects.toBeInstanceOf(ValidationException);
  });
});

describe('MediaService.confirmUpload', () => {
  it('transitions pending → ready when S3 has the object', async () => {
    const { svc, s3 } = buildService();
    const init = await svc.initiateUpload(
      {
        ownerType: 'product',
        ownerId: '11111111-1111-1111-1111-111111111111',
        contentType: 'image/jpeg',
        contentLength: JPEG_BUFFER.length,
      },
      'user-1',
      'tenant-1',
    );
    s3.__seed(init.s3Key, JPEG_BUFFER, 'image/jpeg');

    const view = await svc.confirmUpload({ mediaId: init.mediaId }, 'tenant-1');
    expect(view.status).toBe('ready');
    expect(view.uploadedAt).toBeInstanceOf(Date);
  });

  it('marks failed and throws when S3 has nothing', async () => {
    const { svc, rows } = buildService();
    const init = await svc.initiateUpload(
      { ownerType: 'product', contentType: 'image/jpeg', contentLength: 1024 },
      'user-1',
      'tenant-1',
    );
    await expect(svc.confirmUpload({ mediaId: init.mediaId }, 'tenant-1')).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(rows.get(init.mediaId)!.status).toBe('failed');
  });

  it('is idempotent when called twice', async () => {
    const { svc, s3 } = buildService();
    const init = await svc.initiateUpload(
      { ownerType: 'product', contentType: 'image/jpeg', contentLength: JPEG_BUFFER.length },
      'user-1',
      'tenant-1',
    );
    s3.__seed(init.s3Key, JPEG_BUFFER, 'image/jpeg');
    await svc.confirmUpload({ mediaId: init.mediaId }, 'tenant-1');
    const second = await svc.confirmUpload({ mediaId: init.mediaId }, 'tenant-1');
    expect(second.status).toBe('ready');
  });

  it('rejects when content type changed under us', async () => {
    const { svc, s3 } = buildService();
    const init = await svc.initiateUpload(
      { ownerType: 'product', contentType: 'image/jpeg', contentLength: 1024 },
      'user-1',
      'tenant-1',
    );
    s3.__seed(init.s3Key, JPEG_MAGIC, 'image/png');
    await expect(svc.confirmUpload({ mediaId: init.mediaId }, 'tenant-1')).rejects.toBeInstanceOf(
      ValidationException,
    );
  });

  it('throws DomainNotFoundException for unknown media id', async () => {
    const { svc } = buildService();
    await expect(
      svc.confirmUpload({ mediaId: '00000000-0000-0000-0000-000000000000' }, 'tenant-1'),
    ).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('rejects confirm when status is already failed', async () => {
    const { svc, rows } = buildService();
    const init = await svc.initiateUpload(
      { ownerType: 'product', contentType: 'image/jpeg', contentLength: 1024 },
      'user-1',
      'tenant-1',
    );
    rows.set(init.mediaId, { ...rows.get(init.mediaId)!, status: 'failed' });
    await expect(svc.confirmUpload({ mediaId: init.mediaId }, 'tenant-1')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });
});

describe('MediaService.delete', () => {
  it('soft-deletes the row and removes the S3 object', async () => {
    const { svc, s3, rows } = buildService();
    const init = await svc.initiateUpload(
      { ownerType: 'product', contentType: 'image/jpeg', contentLength: JPEG_BUFFER.length },
      'user-1',
      'tenant-1',
    );
    s3.__seed(init.s3Key, JPEG_BUFFER, 'image/jpeg');
    await svc.delete(init.mediaId, 'user-1', 'tenant-1');

    expect(await s3.objectExists(init.s3Key)).toBe(false);
    expect(rows.get(init.mediaId)!.deletedAt).toBeInstanceOf(Date);
  });
});

describe('MediaService.migrateFromUrl', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('downloads, validates, uploads and persists', async () => {
    const { svc, s3, rows } = buildService();
    const buf = Buffer.concat([JPEG_MAGIC, Buffer.alloc(200)]);
    global.fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      headers: { get: () => 'image/jpeg' },
    })) as unknown as typeof fetch;

    const view = await svc.migrateFromUrl(
      {
        url: 'https://images.openfoodfacts.org/images/products/123/front.jpg',
        productId: '11111111-1111-1111-1111-111111111111',
        ownerType: 'product',
      },
      'system',
      'tenant-1',
    );
    expect(view.status).toBe('ready');
    expect(view.contentType).toBe('image/jpeg');
    expect(rows.size).toBe(1);
    expect(await s3.objectExists(view.s3Key)).toBe(true);
  });

  it('rejects mislabelled bytes (PHP file)', async () => {
    const { svc } = buildService();
    const buf = Buffer.concat([Buffer.from('<?php echo "evil"; ?>'), Buffer.alloc(200)]);
    global.fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      headers: { get: () => 'image/jpeg' },
    })) as unknown as typeof fetch;

    await expect(
      svc.migrateFromUrl(
        {
          url: 'https://attacker.com/evil.jpg',
          productId: '11111111-1111-1111-1111-111111111111',
          ownerType: 'product',
        },
        'system',
        'tenant-1',
      ),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('throws an external error when fetch returns non-2xx', async () => {
    const { svc } = buildService();
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => null },
    })) as unknown as typeof fetch;

    await expect(
      svc.migrateFromUrl(
        {
          url: 'https://broken.example.com/x.jpg',
          productId: '11111111-1111-1111-1111-111111111111',
          ownerType: 'product',
        },
        'system',
        'tenant-1',
      ),
    ).rejects.toBeInstanceOf(ValidationException);
  });
});

describe('MediaService.buildVariants', () => {
  it('produces three CDN URLs (thumbnail, medium, full)', () => {
    const { svc } = buildService();
    const variants = svc.buildVariants({
      s3Key: 'tenant-1/product/abc.jpg',
    } as MediaAssetRow);
    expect(variants.full).toContain('cdn.example.com/tenant-1/product/abc.jpg');
    expect(variants.medium).toContain('cdn.example.com/tenant-1/product/abc.medium.jpg');
    expect(variants.thumbnail).toContain('cdn.example.com/tenant-1/product/abc.thumbnail.jpg');
  });
});
