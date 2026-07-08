import {
  ALLOWED_IMAGE_CONTENT_TYPES,
  buildS3Key,
  buildVariantKey,
  extensionForContentType,
} from '../utils/file-key.utils';

describe('extensionForContentType', () => {
  it('maps known image types', () => {
    expect(extensionForContentType('image/jpeg')).toBe('jpg');
    expect(extensionForContentType('image/png')).toBe('png');
    expect(extensionForContentType('image/webp')).toBe('webp');
    expect(extensionForContentType('image/gif')).toBe('gif');
  });

  it('falls back to bin for unknown types', () => {
    expect(extensionForContentType('application/pdf')).toBe('bin');
  });

  it('is case-insensitive on the lookup', () => {
    expect(extensionForContentType('IMAGE/JPEG')).toBe('jpg');
  });

  it('exposes the canonical content-type whitelist', () => {
    expect(ALLOWED_IMAGE_CONTENT_TYPES).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
    ]);
  });
});

describe('buildS3Key', () => {
  it('produces tenant/owner/id key when all parts present', () => {
    const result = buildS3Key({
      tenantId: '00000000-0000-0000-0000-000000000001',
      ownerType: 'product',
      ownerId: '11111111-1111-1111-1111-111111111111',
      contentType: 'image/jpeg',
    });
    expect(
      result.key.startsWith(
        '00000000-0000-0000-0000-000000000001/product/11111111-1111-1111-1111-111111111111/',
      ),
    ).toBe(true);
    expect(result.key.endsWith('.jpg')).toBe(true);
  });

  it('uses `global` segment when tenantId is null', () => {
    const result = buildS3Key({
      tenantId: null,
      ownerType: 'product',
      ownerId: '11111111-1111-1111-1111-111111111111',
      contentType: 'image/png',
    });
    expect(result.key.startsWith('global/product/')).toBe(true);
    expect(result.key.endsWith('.png')).toBe(true);
  });

  it('shards by media-id prefix when ownerId is missing', () => {
    const result = buildS3Key({
      tenantId: 't-1',
      ownerType: 'tmp',
      contentType: 'image/webp',
      mediaId: 'abcdef00-0000-0000-0000-000000000000',
    });
    expect(result.key).toBe('t-1/tmp/_/ab/abcdef00-0000-0000-0000-000000000000.webp');
    expect(result.mediaId).toBe('abcdef00-0000-0000-0000-000000000000');
  });

  it('returns the supplied media-id when provided (idempotency)', () => {
    const result = buildS3Key({
      tenantId: 't-1',
      ownerType: 'product',
      ownerId: 'p-1',
      contentType: 'image/jpeg',
      mediaId: '11111111-1111-1111-1111-111111111111',
    });
    expect(result.mediaId).toBe('11111111-1111-1111-1111-111111111111');
    expect(result.key.endsWith('11111111-1111-1111-1111-111111111111.jpg')).toBe(true);
  });
});

describe('buildVariantKey', () => {
  it('returns the primary key unchanged for full', () => {
    expect(buildVariantKey('a/b/c.jpg', 'full')).toBe('a/b/c.jpg');
  });

  it('inserts variant before the extension', () => {
    expect(buildVariantKey('a/b/c.jpg', 'thumbnail')).toBe('a/b/c.thumbnail.jpg');
    expect(buildVariantKey('a/b/c.png', 'medium')).toBe('a/b/c.medium.png');
  });

  it('handles keys without an extension', () => {
    expect(buildVariantKey('a/b/c', 'thumbnail')).toBe('a/b/c.thumbnail');
  });
});
