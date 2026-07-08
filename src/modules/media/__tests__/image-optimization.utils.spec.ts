import {
  __setSharpForTests,
  computeOptimizationRatio,
  loadSharp,
  type SharpInstance,
  type SharpModule,
} from '../utils/image-optimization.utils';

describe('computeOptimizationRatio', () => {
  it('returns processed/original ratio', () => {
    expect(computeOptimizationRatio(2_000_000, 500_000)).toBe(0.25);
  });

  it('clamps to 1 for zero or negative original', () => {
    expect(computeOptimizationRatio(0, 100)).toBe(1);
    expect(computeOptimizationRatio(-1, 100)).toBe(1);
  });

  it('clamps to 1 for non-finite inputs', () => {
    expect(computeOptimizationRatio(NaN, 100)).toBe(1);
    expect(computeOptimizationRatio(100, NaN)).toBe(1);
    expect(computeOptimizationRatio(100, -10)).toBe(1);
  });

  it('rounds to 4 decimal places', () => {
    expect(computeOptimizationRatio(3, 1)).toBe(0.3333);
  });
});

describe('loadSharp', () => {
  afterEach(() => {
    __setSharpForTests(undefined);
  });

  it('returns null after explicit unavailable mark', async () => {
    __setSharpForTests(null);
    const sharp = await loadSharp();
    expect(sharp).toBeNull();
  });

  it('returns the injected factory', async () => {
    const fakeInstance: SharpInstance = {
      metadata: jest.fn(async () => ({ width: 100, height: 100, format: 'jpeg' })),
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
      toBuffer: jest.fn(async () => Buffer.alloc(0)),
    };
    const fakeFactory = (() => fakeInstance) as unknown as SharpModule;
    __setSharpForTests(fakeFactory);
    const sharp = await loadSharp();
    expect(sharp).toBe(fakeFactory);
  });
});
