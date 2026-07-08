import { LoggerService } from '@/logging/logger.service';
import type { IS3Service } from '@/integrations/aws/s3/s3.types';

import { ReportStorageService } from '../services/report-storage.service';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildSvc = () => {
  const s3: IS3Service = {
    uploadObject: jest.fn(async (key: string) => key),
    generatePresignedDownloadUrl: jest.fn(
      async (_k: string, ttl: number) => `https://signed/${ttl}`,
    ),
    generatePresignedUploadUrl: jest.fn(),
    downloadObject: jest.fn(),
    deleteObject: jest.fn(async () => undefined),
    copyObject: jest.fn(),
    objectExists: jest.fn(async () => true),
    getObjectMetadata: jest.fn(),
  } as unknown as IS3Service;
  const svc = new ReportStorageService(s3, buildLogger());
  return { svc, s3 };
};

describe('ReportStorageService', () => {
  it('refuses to upload an empty buffer', async () => {
    const { svc, s3 } = buildSvc();
    await expect(svc.upload('k', Buffer.alloc(0), 'text/csv')).rejects.toThrow(/empty/i);
    expect(s3.uploadObject as jest.Mock).not.toHaveBeenCalled();
  });

  it('delegates upload to the underlying S3 service', async () => {
    const { svc, s3 } = buildSvc();
    const key = await svc.upload('tenants/t1/reports/r1/file.csv', Buffer.from('x'), 'text/csv');
    expect(key).toBe('tenants/t1/reports/r1/file.csv');
    expect(s3.uploadObject as jest.Mock).toHaveBeenCalledWith(
      'tenants/t1/reports/r1/file.csv',
      expect.any(Buffer),
      'text/csv',
    );
  });

  it('forwards getDownloadUrl with TTL', async () => {
    const { svc, s3 } = buildSvc();
    const url = await svc.getDownloadUrl('tenants/t1/reports/r1/file.pdf', 3600);
    expect(url).toBe('https://signed/3600');
    expect(s3.generatePresignedDownloadUrl as jest.Mock).toHaveBeenCalledWith(
      'tenants/t1/reports/r1/file.pdf',
      3600,
    );
  });

  it('forwards exists check to S3', async () => {
    const { svc } = buildSvc();
    expect(await svc.exists('k')).toBe(true);
  });

  it('forwards delete to S3', async () => {
    const { svc, s3 } = buildSvc();
    await svc.delete('k');
    expect(s3.deleteObject as jest.Mock).toHaveBeenCalledWith('k');
  });
});
