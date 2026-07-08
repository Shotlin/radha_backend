import { DomainNotFoundException } from '@/common/errors/business.exception';
import { CloudFrontClientService } from '@/integrations/aws/cloudfront/cloudfront-client.service';
import { AuditLogService } from '@/observability/audit-log.service';

import type { MediaAssetRow } from '@/db/schema/media-assets';

import { MediaRepository } from '../media.repository';
import { CdnInvalidatorService } from '../services/cdn-invalidator.service';

const buildAudit = (): AuditLogService =>
  ({ logAction: jest.fn(async () => undefined) }) as unknown as AuditLogService;

const buildMediaRow = (overrides: Partial<MediaAssetRow> = {}): MediaAssetRow =>
  ({
    id: 'media-1',
    tenantId: 'tenant-1',
    ownerType: 'product',
    ownerId: 'p-1',
    s3Bucket: 'radha-test',
    s3Key: 'tenant-1/product/p-1/media-1.jpg',
    contentType: 'image/jpeg',
    contentLength: 100_000,
    status: 'ready',
    variants: {
      thumbnail: { s3Key: 'tenant-1/product/p-1/media-1_thumbnail.webp' },
      small: { s3Key: 'tenant-1/product/p-1/media-1_small.webp' },
      medium: { s3Key: 'tenant-1/product/p-1/media-1_medium.webp' },
      large: { s3Key: 'tenant-1/product/p-1/media-1_large.webp' },
      original: { s3Key: 'tenant-1/product/p-1/media-1.jpg' },
    } as never,
    width: 1024,
    height: 768,
    sourceUrl: null,
    uploadedAt: new Date(),
    processedAt: new Date(),
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

const buildClient = (override: Partial<CloudFrontClientService> = {}): CloudFrontClientService =>
  ({
    isConfigured: jest.fn(() => true),
    createInvalidation: jest.fn(async (paths: string[]) => ({
      invalidationId: 'inv-1',
      paths,
      status: 'in-progress' as const,
    })),
    ...override,
  }) as unknown as CloudFrontClientService;

const buildRepo = (rows: Map<string, MediaAssetRow>): MediaRepository =>
  ({
    findById: jest.fn(async (id: string) => rows.get(id) ?? null),
  }) as unknown as MediaRepository;

describe('CdnInvalidatorService.invalidate', () => {
  it('normalises paths to leading slash', async () => {
    const client = buildClient();
    const svc = new CdnInvalidatorService(client, buildRepo(new Map()), buildAudit());
    const result = await svc.invalidate(['a/b.jpg', '/c/d.webp']);
    expect(client.createInvalidation).toHaveBeenCalledWith(['/a/b.jpg', '/c/d.webp']);
    expect(result.status).toBe('in-progress');
  });

  it('de-duplicates paths', async () => {
    const client = buildClient();
    const svc = new CdnInvalidatorService(client, buildRepo(new Map()), buildAudit());
    await svc.invalidate(['/a.jpg', 'a.jpg', '/a.jpg']);
    expect(client.createInvalidation).toHaveBeenCalledWith(['/a.jpg']);
  });

  it('returns noop when given empty paths', async () => {
    const client = buildClient();
    const svc = new CdnInvalidatorService(client, buildRepo(new Map()), buildAudit());
    const result = await svc.invalidate([]);
    expect(result.invalidationId).toBe('noop');
    expect(client.createInvalidation).not.toHaveBeenCalled();
  });

  it('drops empty + non-string entries', async () => {
    const client = buildClient();
    const svc = new CdnInvalidatorService(client, buildRepo(new Map()), buildAudit());
    await svc.invalidate(['', null as unknown as string, '/x.jpg']);
    expect(client.createInvalidation).toHaveBeenCalledWith(['/x.jpg']);
  });
});

describe('CdnInvalidatorService.invalidateByMediaId', () => {
  it('invalidates s3Key + every variant', async () => {
    const rows = new Map<string, MediaAssetRow>();
    rows.set('media-1', buildMediaRow());
    const client = buildClient();
    const audit = buildAudit();
    const svc = new CdnInvalidatorService(client, buildRepo(rows), audit);
    const result = await svc.invalidateByMediaId('media-1');
    expect(client.createInvalidation).toHaveBeenCalledTimes(1);
    const [paths] = (client.createInvalidation as jest.Mock).mock.calls[0];
    expect(paths).toEqual(
      expect.arrayContaining([
        '/tenant-1/product/p-1/media-1.jpg',
        '/tenant-1/product/p-1/media-1_thumbnail.webp',
        '/tenant-1/product/p-1/media-1_small.webp',
        '/tenant-1/product/p-1/media-1_medium.webp',
        '/tenant-1/product/p-1/media-1_large.webp',
      ]),
    );
    expect(result.status).toBe('in-progress');
    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'media_assets',
        resourceId: 'media-1',
        success: true,
      }),
    );
  });

  it('handles media with no variants', async () => {
    const rows = new Map<string, MediaAssetRow>();
    rows.set('media-2', buildMediaRow({ id: 'media-2', variants: {} as never }));
    const client = buildClient();
    const svc = new CdnInvalidatorService(client, buildRepo(rows), buildAudit());
    const result = await svc.invalidateByMediaId('media-2');
    const [paths] = (client.createInvalidation as jest.Mock).mock.calls[0];
    expect(paths).toEqual(['/tenant-1/product/p-1/media-1.jpg']);
    expect(result.invalidationId).toBe('inv-1');
  });

  it('throws DomainNotFoundException for missing media', async () => {
    const svc = new CdnInvalidatorService(buildClient(), buildRepo(new Map()), buildAudit());
    await expect(svc.invalidateByMediaId('missing')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('records skipped audit entry when CloudFront skips the invalidation', async () => {
    const rows = new Map<string, MediaAssetRow>();
    rows.set('media-1', buildMediaRow());
    const client = buildClient({
      createInvalidation: jest.fn(async (paths: string[]) => ({
        invalidationId: 'skipped-x',
        paths,
        status: 'skipped' as const,
      })),
    });
    const audit = buildAudit();
    const svc = new CdnInvalidatorService(client, buildRepo(rows), audit);
    const result = await svc.invalidateByMediaId('media-1');
    expect(result.status).toBe('skipped');
    expect(audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });
});

describe('CdnInvalidatorService.invalidateAll', () => {
  it('fires a single /* path', async () => {
    const client = buildClient();
    const svc = new CdnInvalidatorService(client, buildRepo(new Map()), buildAudit());
    await svc.invalidateAll();
    expect(client.createInvalidation).toHaveBeenCalledWith(['/*']);
  });
});
