import { ExifStripperService } from '../services/exif-stripper.service';
import {
  __setSharpForTests,
  type SharpInstance,
  type SharpModule,
} from '../utils/image-optimization.utils';

const buildFakeSharp = (overrides: Partial<SharpInstance> = {}): SharpModule => {
  const instance: SharpInstance = {
    metadata: jest.fn(async () => ({ width: 1024, height: 768, format: 'jpeg' })),
    rotate: jest.fn(function rot(this: SharpInstance) {
      return this;
    }),
    resize: jest.fn(function res(this: SharpInstance) {
      return this;
    }),
    webp: jest.fn(function webp(this: SharpInstance) {
      return this;
    }),
    jpeg: jest.fn(function jpeg(this: SharpInstance) {
      return this;
    }),
    png: jest.fn(function png(this: SharpInstance) {
      return this;
    }),
    withMetadata: jest.fn(function wm(this: SharpInstance) {
      return this;
    }),
    toBuffer: jest.fn(async () => Buffer.from([0xff, 0xd8, 0xff])),
    ...overrides,
  } as SharpInstance;

  // Each call to the factory returns the same instance so chained
  // `.rotate()` / `.withMetadata()` return the same `instance` mock.
  return jest.fn(() => instance) as unknown as SharpModule;
};

describe('ExifStripperService', () => {
  afterEach(() => {
    __setSharpForTests(undefined);
  });

  it('returns the original buffer when sharp is not installed', async () => {
    __setSharpForTests(null);
    // Re-construct after reset so the cached factory is null.
    const svc = new ExifStripperService();
    const input = Buffer.from('original');
    const out = await svc.strip(input);
    expect(out).toBe(input);
  });

  it('invokes sharp.rotate().withMetadata({}).toBuffer() in order', async () => {
    const sharp = buildFakeSharp();
    __setSharpForTests(sharp);
    const svc = new ExifStripperService();
    const input = Buffer.from([0xff, 0xd8, 0xff]);
    const out = await svc.strip(input);
    expect(sharp).toHaveBeenCalledWith(input);
    expect(out).toBeInstanceOf(Buffer);
  });

  it('returns original buffer when sharp throws', async () => {
    const sharp = buildFakeSharp({
      rotate: jest.fn(() => {
        throw new Error('libvips boom');
      }) as unknown as SharpInstance['rotate'],
    });
    __setSharpForTests(sharp);
    const svc = new ExifStripperService();
    const input = Buffer.from([0xff, 0xd8, 0xff]);
    const out = await svc.strip(input);
    expect(out).toBe(input);
  });

  it('hasExif is false when no exif on metadata', async () => {
    const sharp = buildFakeSharp();
    __setSharpForTests(sharp);
    const svc = new ExifStripperService();
    const has = await svc.hasExif(Buffer.from([0xff, 0xd8, 0xff]));
    expect(has).toBe(false);
  });

  it('hasExif is true when sharp exposes exif buffer', async () => {
    const sharp = buildFakeSharp({
      metadata: jest.fn(async () => ({
        width: 100,
        height: 100,
        format: 'jpeg',
        exif: Buffer.from('EXIF DATA'),
      })),
    });
    __setSharpForTests(sharp);
    const svc = new ExifStripperService();
    const has = await svc.hasExif(Buffer.from([0xff, 0xd8, 0xff]));
    expect(has).toBe(true);
  });

  it('hasExif tolerates sharp errors', async () => {
    const sharp = buildFakeSharp({
      metadata: jest.fn(async () => {
        throw new Error('bad bytes');
      }),
    });
    __setSharpForTests(sharp);
    const svc = new ExifStripperService();
    const has = await svc.hasExif(Buffer.from([0xff, 0xd8, 0xff]));
    expect(has).toBe(false);
  });
});
