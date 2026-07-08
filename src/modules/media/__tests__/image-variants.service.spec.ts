import { ImageVariantsService } from '../services/image-variants.service';

describe('ImageVariantsService', () => {
  const svc = new ImageVariantsService();

  it('exposes four variants in display order', () => {
    expect(svc.names()).toEqual(['thumbnail', 'small', 'medium', 'large']);
  });

  it('returns the canonical config for each variant', () => {
    expect(svc.get('thumbnail')).toEqual({
      name: 'thumbnail',
      width: 150,
      height: 150,
      quality: 80,
      format: 'webp',
      effort: 4,
    });
    expect(svc.get('large')).toEqual({
      name: 'large',
      width: 1600,
      height: 1600,
      quality: 90,
      format: 'webp',
      effort: 4,
    });
  });

  it('throws for unknown variants', () => {
    expect(() => svc.get('giant' as never)).toThrow();
  });

  it('produces a list immutable to the caller', () => {
    const list = svc.list();
    expect(() => {
      (list as unknown as Array<unknown>).push(123);
    }).toThrow();
  });

  it('builds variant keys with underscore separator and webp extension', () => {
    expect(svc.buildVariantKey('tenant-1/product/abc/uuid.jpg', 'thumbnail')).toBe(
      'tenant-1/product/abc/uuid_thumbnail.webp',
    );
    expect(svc.buildVariantKey('tenant-1/product/abc/uuid.png', 'large')).toBe(
      'tenant-1/product/abc/uuid_large.webp',
    );
  });

  it('handles keys without an extension', () => {
    expect(svc.buildVariantKey('tenant-1/product/abc/uuid', 'medium')).toBe(
      'tenant-1/product/abc/uuid_medium.webp',
    );
  });

  it('handles keys with dotted directory names safely', () => {
    expect(svc.buildVariantKey('tenant.global/product/abc.jpg', 'small')).toBe(
      'tenant.global/product/abc_small.webp',
    );
  });

  it('handles keys at the root', () => {
    expect(svc.buildVariantKey('uuid.jpg', 'thumbnail')).toBe('uuid_thumbnail.webp');
  });
});
