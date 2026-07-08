import { ValidationException } from '@/common/errors/business.exception';

import { ImageValidatorService } from '../services/image-validator.service';

const JPEG_MAGIC = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const WEBP_MAGIC = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const GIF_MAGIC = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

describe('ImageValidatorService.validateContentType', () => {
  let svc: ImageValidatorService;
  beforeEach(() => {
    svc = new ImageValidatorService();
  });

  it('accepts image/jpeg, image/png, image/webp, image/gif', () => {
    for (const ct of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(() => svc.validateContentType(ct)).not.toThrow();
    }
  });

  it('rejects application/exe', () => {
    expect(() => svc.validateContentType('application/exe')).toThrow(ValidationException);
  });

  it('rejects an empty string', () => {
    expect(() => svc.validateContentType('')).toThrow(ValidationException);
  });
});

describe('ImageValidatorService.validateSize', () => {
  let svc: ImageValidatorService;
  beforeEach(() => {
    svc = new ImageValidatorService();
  });

  it('rejects sub-100-byte uploads', () => {
    expect(() => svc.validateSize(50)).toThrow(ValidationException);
  });

  it('rejects 0-byte uploads', () => {
    expect(() => svc.validateSize(0)).toThrow(ValidationException);
  });

  it('rejects > 10MB uploads', () => {
    expect(() => svc.validateSize(11 * 1024 * 1024)).toThrow(ValidationException);
  });

  it('accepts 100-byte uploads', () => {
    expect(() => svc.validateSize(100)).not.toThrow();
  });

  it('accepts exact 10MB uploads', () => {
    expect(() => svc.validateSize(10 * 1024 * 1024)).not.toThrow();
  });

  it('rejects NaN', () => {
    expect(() => svc.validateSize(Number.NaN)).toThrow(ValidationException);
  });
});

describe('ImageValidatorService.detectFormat', () => {
  let svc: ImageValidatorService;
  beforeEach(() => {
    svc = new ImageValidatorService();
  });

  it('detects JPEG', () => {
    expect(svc.detectFormat(JPEG_MAGIC)).toEqual({ format: 'jpeg', recognised: true });
  });

  it('detects PNG', () => {
    expect(svc.detectFormat(PNG_MAGIC)).toEqual({ format: 'png', recognised: true });
  });

  it('detects WebP', () => {
    expect(svc.detectFormat(WEBP_MAGIC)).toEqual({ format: 'webp', recognised: true });
  });

  it('detects GIF', () => {
    expect(svc.detectFormat(GIF_MAGIC)).toEqual({ format: 'gif', recognised: true });
  });

  it('returns unknown for plain text disguised as image', () => {
    const phpPayload = Buffer.from('<?php echo "hello"; ?>');
    expect(svc.detectFormat(phpPayload)).toEqual({ format: 'unknown', recognised: false });
  });

  it('returns unknown for short buffers', () => {
    expect(svc.detectFormat(Buffer.from([0xff, 0xd8]))).toEqual({
      format: 'unknown',
      recognised: false,
    });
  });
});

describe('ImageValidatorService.validateImageBuffer', () => {
  let svc: ImageValidatorService;
  beforeEach(() => {
    svc = new ImageValidatorService();
  });

  it('accepts a JPEG with declared image/jpeg', () => {
    const buf = Buffer.concat([JPEG_MAGIC, Buffer.alloc(200)]);
    expect(svc.validateImageBuffer(buf, 'image/jpeg')).toMatchObject({ format: 'jpeg' });
  });

  it('rejects mislabelled bytes (PNG declared as JPEG)', () => {
    const buf = Buffer.concat([PNG_MAGIC, Buffer.alloc(200)]);
    expect(() => svc.validateImageBuffer(buf, 'image/jpeg')).toThrow(ValidationException);
  });

  it('rejects PHP file disguised as image/jpeg', () => {
    const buf = Buffer.concat([Buffer.from('<?php echo "evil"; ?>'), Buffer.alloc(200)]);
    expect(() => svc.validateImageBuffer(buf, 'image/jpeg')).toThrow(ValidationException);
  });

  it('rejects short buffers regardless of declared type', () => {
    const buf = Buffer.from([0xff, 0xd8]);
    expect(() => svc.validateImageBuffer(buf, 'image/jpeg')).toThrow(ValidationException);
  });

  it('accepts image/jpg as alias for image/jpeg', () => {
    const buf = Buffer.concat([JPEG_MAGIC, Buffer.alloc(200)]);
    expect(svc.validateImageBuffer(buf, 'image/jpg')).toMatchObject({ format: 'jpeg' });
  });
});
