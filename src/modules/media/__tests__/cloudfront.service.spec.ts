import { ConfigService } from '@/config/config.service';
import { CloudFrontService } from '@/integrations/aws/cloudfront/cloudfront.service';

const mkConfig = (cloudfrontDomain: string): ConfigService =>
  ({
    aws: {
      region: 'ap-south-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      s3: { bucket: 'radha-test', region: 'ap-south-1', presignedUrlExpirySeconds: 600 },
      cloudfront: { domain: cloudfrontDomain },
    },
  }) as unknown as ConfigService;

describe('CloudFrontService.getCdnUrl', () => {
  it('uses CloudFront domain when configured', () => {
    const svc = new CloudFrontService(mkConfig('cdn.example.com'));
    expect(svc.getCdnUrl('tenant-1/product/abc.jpg')).toBe(
      'https://cdn.example.com/tenant-1/product/abc.jpg',
    );
  });

  it('falls back to S3 URL when domain is empty', () => {
    const svc = new CloudFrontService(mkConfig(''));
    expect(svc.getCdnUrl('tenant-1/product/abc.jpg')).toBe(
      'https://radha-test.s3.ap-south-1.amazonaws.com/tenant-1/product/abc.jpg',
    );
  });

  it('strips leading slashes from keys', () => {
    const svc = new CloudFrontService(mkConfig('cdn.example.com'));
    expect(svc.getCdnUrl('/leading/slash.jpg')).toBe('https://cdn.example.com/leading/slash.jpg');
  });
});

describe('CloudFrontService.getVariantUrl', () => {
  it('returns the primary URL for full', () => {
    const svc = new CloudFrontService(mkConfig('cdn.example.com'));
    expect(svc.getVariantUrl('a/b/c.jpg', 'full')).toBe('https://cdn.example.com/a/b/c.jpg');
  });

  it('inserts variant before the extension', () => {
    const svc = new CloudFrontService(mkConfig('cdn.example.com'));
    expect(svc.getVariantUrl('a/b/c.jpg', 'thumbnail')).toBe(
      'https://cdn.example.com/a/b/c.thumbnail.jpg',
    );
    expect(svc.getVariantUrl('a/b/c.png', 'medium')).toBe(
      'https://cdn.example.com/a/b/c.medium.png',
    );
  });
});
