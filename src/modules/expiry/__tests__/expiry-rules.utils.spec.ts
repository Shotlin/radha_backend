import {
  ThresholdLike,
  calculateExpiryStatus,
  daysUntilExpiry,
  statusColor,
} from '../utils/expiry-rules.utils';

const NOW = new Date('2026-06-01T00:00:00Z');
const T: ThresholdLike = { yellowDays: 30, redDays: 7 };

const dateOf = (iso: string) => new Date(iso);

describe('daysUntilExpiry', () => {
  it('returns null when expiry date is missing', () => {
    expect(daysUntilExpiry(null, NOW)).toBeNull();
    expect(daysUntilExpiry(undefined, NOW)).toBeNull();
  });

  it('returns positive integers for future dates', () => {
    expect(daysUntilExpiry(dateOf('2026-06-15T00:00:00Z'), NOW)).toBe(14);
    expect(daysUntilExpiry(dateOf('2026-07-01T00:00:00Z'), NOW)).toBe(30);
  });

  it('returns negative integers for past dates', () => {
    expect(daysUntilExpiry(dateOf('2026-05-25T00:00:00Z'), NOW)).toBe(-7);
  });
});

describe('calculateExpiryStatus', () => {
  it('returns unknown for missing dates', () => {
    expect(calculateExpiryStatus(null, T, NOW)).toBe('unknown');
  });

  it('returns expired for past dates', () => {
    expect(calculateExpiryStatus(dateOf('2026-05-30T00:00:00Z'), T, NOW)).toBe('expired');
  });

  it('returns red within redDays', () => {
    expect(calculateExpiryStatus(dateOf('2026-06-05T00:00:00Z'), T, NOW)).toBe('red');
    expect(calculateExpiryStatus(dateOf('2026-06-08T00:00:00Z'), T, NOW)).toBe('red');
  });

  it('returns yellow between redDays and yellowDays', () => {
    expect(calculateExpiryStatus(dateOf('2026-06-15T00:00:00Z'), T, NOW)).toBe('yellow');
    expect(calculateExpiryStatus(dateOf('2026-07-01T00:00:00Z'), T, NOW)).toBe('yellow');
  });

  it('returns green beyond yellowDays', () => {
    expect(calculateExpiryStatus(dateOf('2026-08-01T00:00:00Z'), T, NOW)).toBe('green');
  });

  it('honours category-specific thresholds (dairy yellow=7 red=2)', () => {
    const dairy: ThresholdLike = { yellowDays: 7, redDays: 2 };
    expect(calculateExpiryStatus(dateOf('2026-06-02T00:00:00Z'), dairy, NOW)).toBe('red');
    expect(calculateExpiryStatus(dateOf('2026-06-05T00:00:00Z'), dairy, NOW)).toBe('yellow');
    expect(calculateExpiryStatus(dateOf('2026-06-15T00:00:00Z'), dairy, NOW)).toBe('green');
  });
});

describe('statusColor', () => {
  it('maps statuses to UI colors', () => {
    expect(statusColor('green')).toBe('green');
    expect(statusColor('yellow')).toBe('yellow');
    expect(statusColor('red')).toBe('red');
    expect(statusColor('expired')).toBe('red');
    expect(statusColor('unknown')).toBe('gray');
  });
});
