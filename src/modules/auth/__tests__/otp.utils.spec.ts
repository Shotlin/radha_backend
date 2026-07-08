import { generateOtp, hashOtp, verifyOtp } from '../utils/otp.utils';

describe('generateOtp', () => {
  it('produces a numeric string of the requested length', () => {
    for (const len of [4, 5, 6, 7, 8]) {
      const otp = generateOtp(len);
      expect(otp).toHaveLength(len);
      expect(otp).toMatch(/^\d+$/);
    }
  });

  it('rejects out-of-range lengths', () => {
    expect(() => generateOtp(3)).toThrow();
    expect(() => generateOtp(9)).toThrow();
  });

  it('produces high-entropy values across many calls', () => {
    const set = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) set.add(generateOtp(6));
    // 1000 6-digit OTPs should give us ≥ 950 unique values; the chance
    // of collisions in 10^6 space is small but non-zero.
    expect(set.size).toBeGreaterThanOrEqual(950);
  });
});

describe('hashOtp / verifyOtp', () => {
  it('round-trips a valid OTP', async () => {
    const hash = await hashOtp('123456');
    expect(await verifyOtp('123456', hash)).toBe(true);
    expect(await verifyOtp('123457', hash)).toBe(false);
  });

  it('returns false for malformed hashes', async () => {
    expect(await verifyOtp('123456', 'not-a-bcrypt-hash')).toBe(false);
  });
});
