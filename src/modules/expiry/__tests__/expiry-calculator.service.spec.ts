import { ExpiryCalculatorService } from '../services/expiry-calculator.service';

const svc = new ExpiryCalculatorService();
const NOW = new Date('2026-06-01T00:00:00Z');
const T = { yellowDays: 30, redDays: 7 };

describe('ExpiryCalculatorService', () => {
  it('delegates to the pure helpers and returns the expected enum', () => {
    expect(svc.calculateStatus(new Date('2026-06-05T00:00:00Z'), T, NOW)).toBe('red');
    expect(svc.calculateStatus(new Date('2026-08-01T00:00:00Z'), T, NOW)).toBe('green');
  });

  it('isExpired is true only for past dates', () => {
    expect(svc.isExpired(new Date('2026-05-01T00:00:00Z'), NOW)).toBe(true);
    expect(svc.isExpired(new Date('2026-06-01T00:00:00Z'), NOW)).toBe(false);
    expect(svc.isExpired(null, NOW)).toBe(false);
  });

  it('returns null daysUntilExpiry for missing input', () => {
    expect(svc.daysUntilExpiry(null, NOW)).toBeNull();
    expect(svc.daysUntilExpiry(undefined, NOW)).toBeNull();
  });

  it('exposes the same statusColor mapping', () => {
    expect(svc.statusColor('expired')).toBe('red');
    expect(svc.statusColor('green')).toBe('green');
  });
});
