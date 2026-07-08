import { ExternalServiceException } from '@/common/errors/business.exception';
import { ConfigService } from '@/config/config.service';

import { CloudFrontClientService } from '../cloudfront-client.service';

const buildConfig = (cf: { domain?: string; distributionId?: string } = {}): ConfigService =>
  ({
    aws: {
      region: 'ap-south-1',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
      s3: { bucket: 'b', region: 'ap-south-1', presignedUrlExpirySeconds: 600 },
      cloudfront: {
        domain: cf.domain ?? 'cdn.example.com',
        distributionId: cf.distributionId,
      },
    },
  }) as unknown as ConfigService;

describe('CloudFrontClientService.isConfigured', () => {
  it('is true when distributionId is set', () => {
    const svc = new CloudFrontClientService(buildConfig({ distributionId: 'E123' }));
    expect(svc.isConfigured()).toBe(true);
  });

  it('is false when distributionId is missing', () => {
    const svc = new CloudFrontClientService(buildConfig());
    expect(svc.isConfigured()).toBe(false);
  });
});

describe('CloudFrontClientService.createInvalidation', () => {
  it('returns completed-noop for empty paths', async () => {
    const svc = new CloudFrontClientService(buildConfig({ distributionId: 'E123' }));
    const result = await svc.createInvalidation([]);
    expect(result.status).toBe('completed');
    expect(result.invalidationId).toBe('noop');
  });

  it('returns skipped when distributionId is not configured', async () => {
    const svc = new CloudFrontClientService(buildConfig());
    const result = await svc.createInvalidation(['/a.jpg']);
    expect(result.status).toBe('skipped');
    expect(result.invalidationId).toMatch(/^skipped-/);
    expect(result.paths).toEqual(['/a.jpg']);
  });

  it('returns skipped when SDK is not installed', async () => {
    const svc = new CloudFrontClientService(buildConfig({ distributionId: 'E123' }));
    // Force the dynamic loader to fail by overriding the private method.
    (svc as unknown as { ensureSdk: () => Promise<null> }).ensureSdk = async () => null;
    const result = await svc.createInvalidation(['/x.jpg']);
    expect(result.status).toBe('skipped');
  });

  it('translates AWS errors into ExternalServiceException', async () => {
    const svc = new CloudFrontClientService(buildConfig({ distributionId: 'E123' }));
    const sdk = {
      module: {
        CreateInvalidationCommand: function FakeCmd() {
          return {};
        },
      },
      client: {
        send: jest.fn(async () => {
          throw new Error('AccessDenied');
        }),
      },
    };
    (svc as unknown as { ensureSdk: () => Promise<typeof sdk> }).ensureSdk = async () => sdk;

    await expect(svc.createInvalidation(['/x.jpg'])).rejects.toBeInstanceOf(
      ExternalServiceException,
    );
  });

  it('returns in-progress on SDK success', async () => {
    const svc = new CloudFrontClientService(buildConfig({ distributionId: 'E123' }));
    const sdk = {
      module: {
        CreateInvalidationCommand: function FakeCmd() {
          return {};
        },
      },
      client: {
        send: jest.fn(async () => ({ Invalidation: { Id: 'I-abc' } })),
      },
    };
    (svc as unknown as { ensureSdk: () => Promise<typeof sdk> }).ensureSdk = async () => sdk;

    const result = await svc.createInvalidation(['/a.jpg', '/b.jpg']);
    expect(result.invalidationId).toBe('I-abc');
    expect(result.status).toBe('in-progress');
    expect(result.paths).toEqual(['/a.jpg', '/b.jpg']);
  });

  it('handles missing Invalidation.Id in SDK response', async () => {
    const svc = new CloudFrontClientService(buildConfig({ distributionId: 'E123' }));
    const sdk = {
      module: {
        CreateInvalidationCommand: function FakeCmd() {
          return {};
        },
      },
      client: { send: jest.fn(async () => ({})) },
    };
    (svc as unknown as { ensureSdk: () => Promise<typeof sdk> }).ensureSdk = async () => sdk;

    const result = await svc.createInvalidation(['/a.jpg']);
    expect(result.invalidationId).toMatch(/^unknown-/);
  });
});
