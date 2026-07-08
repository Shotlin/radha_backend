import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ConfigService } from '@/config/config.service';
import { CloudFrontService } from '@/integrations/aws/cloudfront/cloudfront.service';
import { MockS3Service } from '@/integrations/aws/s3/mock-s3.service';
import { AuditLogService } from '@/observability/audit-log.service';

import type { MediaAssetRow } from '@/db/schema/media-assets';

import { MediaRepository } from '../media.repository';
import { ExifStripperService } from '../services/exif-stripper.service';
import { ImageProcessorService } from '../services/image-processor.service';
import { ImageVariantsService } from '../services/image-variants.service';
import {
  __setSharpForTests,
  type SharpInstance,
  type SharpModule,
} from '../utils/image-optimization.utils';

const JPEG_MAGIC = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

const buildConfig = (): ConfigService =>
  ({
    aws: {
      region: 'ap-south-1',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
      s3: { bucket: 'radha-test', region: 'ap-south-1', presignedUrlExpirySeconds: 600 },
      cloudfront: { domain: 'cdn.example.com' },
    },
  }) as unknown as ConfigService;

const buildRow = (overrides: Partial<MediaAssetRow> = {}): MediaAssetRow =>
  ({
    id: 'media-1',
    tenantId: 'tenant-1',
    ownerType: 'product',
    ownerId: 'p-1',
    s3Bucket: 'radha-test',
    s3Key: 'tenant-1/product/p-1/media-1.jpg',
    contentType: 'image/jpeg',
    contentLength: 200_000,
    status: 'uploaded',
    variants: {} as never,
    width: null,
    height: null,
    sourceUrl: null,
    uploadedAt: new Date(),
    processedAt: null,
    uploadedBy: 'user-1',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    createdBy: null,
    updatedBy: null,
    deletedBy: null,
    ...overrides,
  }) as unknown as MediaAssetRow;

const buildRepo = (rows: Map<string, MediaAssetRow>): MediaRepository =>
  ({
    findById: jest.fn(async (id: string) => rows.get(id) ?? null),
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
  }) as unknown as MediaRepository;

interface FakeSharpOptions {
  metadata?: () => Promise<{ width?: number; height?: number; format?: string; exif?: Buffer }>;
  toBuffer?: () => Promise<Buffer>;
}

const buildFakeSharp = (opts: FakeSharpOptions = {}): SharpModule => {
  const factory = ((_input: Buffer): SharpInstance => {
    const inst: SharpInstance = {
      metadata: opts.metadata
        ? jest.fn(opts.metadata)
        : jest.fn(async () => ({ width: 1024, height: 768, format: 'jpeg' })),
      rotate: jest.fn(function rot(this: SharpInstance) {
        return this;
      }),
      resize: jest.fn(function res(this: SharpInstance) {
        return this;
      }),
      webp: jest.fn(function w(this: SharpInstance) {
        return this;
      }),
      jpeg: jest.fn(function j(this: SharpInstance) {
        return this;
      }),
      png: jest.fn(function p(this: SharpInstance) {
        return this;
      }),
      withMetadata: jest.fn(function wm(this: SharpInstance) {
        return this;
      }),
      toBuffer: jest.fn(opts.toBuffer ?? (async () => Buffer.alloc(50_000, 0xab))),
    } as SharpInstance;
    return inst;
  }) as unknown as SharpModule;
  return factory;
};

const buildProcessor = (
  rows: Map<string, MediaAssetRow>,
  s3?: MockS3Service,
): {
  processor: ImageProcessorService;
  s3: MockS3Service;
  repo: MediaRepository;
  audit: AuditLogService;
} => {
  const config = buildConfig();
  const cdn = new CloudFrontService(config);
  const realS3 = s3 ?? new MockS3Service();
  const repo = buildRepo(rows);
  const variants = new ImageVariantsService();
  const exif = new ExifStripperService();
  const audit = { logAction: jest.fn(async () => undefined) } as unknown as AuditLogService;
  const processor = new ImageProcessorService(realS3, cdn, repo, variants, exif, audit);
  return { processor, s3: realS3, repo, audit };
};

describe('ImageProcessorService.processImage', () => {
  beforeEach(() => {
    __setSharpForTests(buildFakeSharp());
  });
  afterEach(() => {
    __setSharpForTests(undefined);
  });

  it('throws DomainNotFoundException for unknown media', async () => {
    const { processor } = buildProcessor(new Map());
    await expect(processor.processImage('missing')).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('rejects deleted media', async () => {
    const rows = new Map([['m-d', buildRow({ id: 'm-d', status: 'deleted' })]]);
    const { processor } = buildProcessor(rows);
    await expect(processor.processImage('m-d')).rejects.toBeInstanceOf(BusinessException);
  });

  it('rejects pending media', async () => {
    const rows = new Map([['m-p', buildRow({ id: 'm-p', status: 'pending' })]]);
    const { processor } = buildProcessor(rows);
    await expect(processor.processImage('m-p')).rejects.toBeInstanceOf(BusinessException);
  });

  it('throws when sharp is not installed', async () => {
    __setSharpForTests(null);
    const rows = new Map([['m-1', buildRow()]]);
    const { processor } = buildProcessor(rows);
    await expect(processor.processImage('m-1')).rejects.toBeInstanceOf(BusinessException);
  });

  it('happy path: uploads four variants + persists manifest + transitions to ready', async () => {
    const rows = new Map([['m-ok', buildRow({ id: 'm-ok' })]]);
    const s3 = new MockS3Service();
    s3.__seed('tenant-1/product/p-1/m-ok.jpg', JPEG_MAGIC, 'image/jpeg');
    // The seed sets s3 key = original. Update the row to match:
    rows.set('m-ok', buildRow({ id: 'm-ok', s3Key: 'tenant-1/product/p-1/m-ok.jpg' }));

    const { processor, repo, audit } = buildProcessor(rows, s3);
    const result = await processor.processImage('m-ok');

    expect(result.mediaId).toBe('m-ok');
    expect(Object.keys(result.variants)).toEqual(
      expect.arrayContaining(['thumbnail', 'small', 'medium', 'large', 'original']),
    );
    expect(result.totalSizeBytes).toBeGreaterThan(0);
    expect(result.optimizationRatio).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const final = rows.get('m-ok')!;
    expect(final.status).toBe('ready');
    expect(final.processedAt).toBeInstanceOf(Date);
    expect(final.width).toBe(1024);
    expect(final.height).toBe(768);
    const manifest = final.variants as unknown as Record<string, { s3Key: string; format: string }>;
    expect(manifest.thumbnail.s3Key).toBe('tenant-1/product/p-1/m-ok_thumbnail.webp');
    expect(manifest.thumbnail.format).toBe('webp');
    expect(repo.markStatus).toHaveBeenCalledWith('m-ok', 'processing');
    expect(repo.update).toHaveBeenCalled();
    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'media_assets',
        resourceId: 'm-ok',
        success: true,
      }),
    );
  });

  it('uploads variant bytes to S3 under the underscore-keyed paths', async () => {
    const rows = new Map([['m-2', buildRow({ id: 'm-2', s3Key: 'tenant-1/product/p-1/m-2.jpg' })]]);
    const s3 = new MockS3Service();
    s3.__seed('tenant-1/product/p-1/m-2.jpg', JPEG_MAGIC, 'image/jpeg');
    const { processor } = buildProcessor(rows, s3);
    await processor.processImage('m-2');

    expect(await s3.objectExists('tenant-1/product/p-1/m-2_thumbnail.webp')).toBe(true);
    expect(await s3.objectExists('tenant-1/product/p-1/m-2_small.webp')).toBe(true);
    expect(await s3.objectExists('tenant-1/product/p-1/m-2_medium.webp')).toBe(true);
    expect(await s3.objectExists('tenant-1/product/p-1/m-2_large.webp')).toBe(true);
  });

  it('marks failed when sharp throws mid-pipeline', async () => {
    // The EXIF stripper deliberately swallows errors and returns the
    // original buffer (verified in `exif-stripper.service.spec.ts`),
    // so the failure must surface AFTER the strip step. We make
    // `metadata()` throw — that's the very next call inside
    // `processImage`, and it bubbles up to the catch that flips the
    // row to `failed`.
    __setSharpForTests(
      buildFakeSharp({
        metadata: async () => {
          throw new Error('libvips: unsupported image format');
        },
      }),
    );
    const rows = new Map([
      ['m-bad', buildRow({ id: 'm-bad', s3Key: 'tenant-1/product/p-1/m-bad.jpg' })],
    ]);
    const s3 = new MockS3Service();
    s3.__seed('tenant-1/product/p-1/m-bad.jpg', JPEG_MAGIC, 'image/jpeg');

    const { processor } = buildProcessor(rows, s3);
    await expect(processor.processImage('m-bad')).rejects.toThrow();
    expect(rows.get('m-bad')!.status).toBe('failed');
  });

  it('marks failed when S3 download fails', async () => {
    const rows = new Map([['m-3', buildRow({ id: 'm-3', s3Key: 'missing-key.jpg' })]]);
    const { processor } = buildProcessor(rows);
    await expect(processor.processImage('m-3')).rejects.toThrow();
    expect(rows.get('m-3')!.status).toBe('failed');
  });
});

describe('ImageProcessorService.buildVariantManifest', () => {
  const rows = new Map<string, MediaAssetRow>();
  rows.set('m', buildRow());
  const { processor } = buildProcessor(rows);

  it('returns null when variants is empty', () => {
    expect(processor.buildVariantManifest(buildRow({ variants: {} as never }))).toBeNull();
  });

  it('returns a typed manifest for fully-processed media', () => {
    const variants = {
      thumbnail: {
        s3Key: 'a_thumbnail.webp',
        cdnUrl: 'https://cdn.example.com/a_thumbnail.webp',
        width: 150,
        height: 150,
        sizeBytes: 5_000,
        format: 'webp',
      },
      small: {
        s3Key: 'a_small.webp',
        cdnUrl: 'https://cdn.example.com/a_small.webp',
        width: 400,
        height: 400,
        sizeBytes: 20_000,
        format: 'webp',
      },
      medium: {
        s3Key: 'a_medium.webp',
        cdnUrl: 'https://cdn.example.com/a_medium.webp',
        width: 800,
        height: 800,
        sizeBytes: 50_000,
        format: 'webp',
      },
      large: {
        s3Key: 'a_large.webp',
        cdnUrl: 'https://cdn.example.com/a_large.webp',
        width: 1600,
        height: 1600,
        sizeBytes: 150_000,
        format: 'webp',
      },
      original: {
        s3Key: 'a.jpg',
        cdnUrl: 'https://cdn.example.com/a.jpg',
        width: 1600,
        height: 1600,
        sizeBytes: 200_000,
        format: 'jpeg',
      },
    };
    const manifest = processor.buildVariantManifest(buildRow({ variants: variants as never }));
    expect(manifest).not.toBeNull();
    expect(manifest!.thumbnail.s3Key).toBe('a_thumbnail.webp');
    expect(manifest!.large.format).toBe('webp');
    expect(manifest!.original.format).toBe('jpeg');
  });

  it('returns null when only some variants present', () => {
    const partial = {
      thumbnail: {
        s3Key: 'x.webp',
        cdnUrl: 'u',
        width: 1,
        height: 1,
        sizeBytes: 1,
        format: 'webp',
      },
    };
    expect(processor.buildVariantManifest(buildRow({ variants: partial as never }))).toBeNull();
  });
});
