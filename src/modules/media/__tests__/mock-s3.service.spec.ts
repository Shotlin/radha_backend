import { MockS3Service } from '@/integrations/aws/s3/mock-s3.service';

describe('MockS3Service', () => {
  let svc: MockS3Service;
  beforeEach(() => {
    svc = new MockS3Service();
  });

  it('round-trips uploadObject + downloadObject', async () => {
    await svc.uploadObject('a/b.txt', Buffer.from('hello'), 'text/plain');
    const out = await svc.downloadObject('a/b.txt');
    expect(out.toString()).toBe('hello');
  });

  it('reports objectExists correctly', async () => {
    expect(await svc.objectExists('does/not/exist')).toBe(false);
    await svc.uploadObject('exists/key.bin', Buffer.from([1, 2, 3]), 'application/octet-stream');
    expect(await svc.objectExists('exists/key.bin')).toBe(true);
  });

  it('returns metadata on HEAD', async () => {
    await svc.uploadObject('m/m.jpg', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    const meta = await svc.getObjectMetadata('m/m.jpg');
    expect(meta.contentType).toBe('image/jpeg');
    expect(meta.contentLength).toBe(3);
  });

  it('throws on metadata for missing keys', async () => {
    await expect(svc.getObjectMetadata('nope')).rejects.toThrow();
  });

  it('deletes objects', async () => {
    await svc.uploadObject('to-delete', Buffer.from('x'), 'text/plain');
    await svc.deleteObject('to-delete');
    expect(await svc.objectExists('to-delete')).toBe(false);
  });

  it('copies between keys', async () => {
    await svc.uploadObject('src', Buffer.from('payload'), 'text/plain');
    await svc.copyObject('src', 'dst');
    expect((await svc.downloadObject('dst')).toString()).toBe('payload');
  });

  it('issues a presigned URL with the right shape', async () => {
    const result = await svc.generatePresignedUploadUrl({
      key: 'tenant/p/abc.jpg',
      contentType: 'image/jpeg',
      contentLength: 1024,
    });
    expect(result.url).toContain('/_mock-s3/upload/');
    expect(result.fields['Content-Type']).toBe('image/jpeg');
    expect(result.expiresIn).toBe(600);
    expect(result.uploadKey).toBe('tenant/p/abc.jpg');
  });
});
