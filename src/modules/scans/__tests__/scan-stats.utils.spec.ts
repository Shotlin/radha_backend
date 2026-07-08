import { calculateExpiryStatus, calculateScanRate } from '../utils/scan-stats.utils';

describe('calculateExpiryStatus', () => {
  const now = new Date('2026-05-01T00:00:00Z');

  it('returns unknown when expiryDate is missing', () => {
    expect(calculateExpiryStatus(null, now)).toBe('unknown');
    expect(calculateExpiryStatus(undefined, now)).toBe('unknown');
  });

  it('returns red for already-expired products', () => {
    expect(calculateExpiryStatus(new Date('2026-04-30T00:00:00Z'), now)).toBe('red');
    expect(calculateExpiryStatus(new Date('2025-01-01T00:00:00Z'), now)).toBe('red');
  });

  it('returns red for expires-within-7-days', () => {
    expect(calculateExpiryStatus(new Date('2026-05-05T00:00:00Z'), now)).toBe('red');
    expect(calculateExpiryStatus(new Date('2026-05-07T11:00:00Z'), now)).toBe('red');
  });

  it('returns yellow for 8–30 days out', () => {
    expect(calculateExpiryStatus(new Date('2026-05-15T00:00:00Z'), now)).toBe('yellow');
    expect(calculateExpiryStatus(new Date('2026-05-31T00:00:00Z'), now)).toBe('yellow');
  });

  it('returns green for > 30 days out', () => {
    expect(calculateExpiryStatus(new Date('2026-06-15T00:00:00Z'), now)).toBe('green');
    expect(calculateExpiryStatus(new Date('2027-01-01T00:00:00Z'), now)).toBe('green');
  });
});

describe('calculateScanRate', () => {
  it('returns 0 when duration is 0', () => {
    const t = new Date();
    expect(calculateScanRate({ totalScans: 5, startedAt: t, endedAt: t })).toBe(0);
  });

  it('returns scans per minute, rounded to 1 decimal', () => {
    const start = new Date('2026-05-01T10:00:00Z');
    const end = new Date('2026-05-01T10:05:00Z'); // 5 minutes
    expect(calculateScanRate({ totalScans: 25, startedAt: start, endedAt: end })).toBe(5);
  });

  it('uses `now` when endedAt missing', () => {
    const start = new Date('2026-05-01T10:00:00Z');
    const now = new Date('2026-05-01T10:01:00Z');
    expect(calculateScanRate({ totalScans: 12, startedAt: start, now })).toBe(12);
  });

  it('rounds 33/60 = 33 per 60s = 33/min for 1 min interval', () => {
    const start = new Date('2026-05-01T10:00:00Z');
    const end = new Date('2026-05-01T10:01:00Z');
    expect(calculateScanRate({ totalScans: 33, startedAt: start, endedAt: end })).toBe(33);
  });
});
