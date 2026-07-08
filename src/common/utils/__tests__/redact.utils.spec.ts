import { redactPII } from '../redact.utils';

describe('redactPII', () => {
  it('redacts password / secret / token fields by name', () => {
    const out = redactPII({ username: 'u', password: 'p', secret: 's', token: 't' });
    expect(out).toEqual({
      username: 'u',
      password: '[REDACTED]',
      secret: '[REDACTED]',
      token: '[REDACTED]',
    });
  });

  it('redacts mobile numbers in free text', () => {
    const out = redactPII({ message: 'Please call 9876543210 immediately' });
    expect(out.message).toBe('Please call [REDACTED] immediately');
  });

  it('redacts Aadhaar in free text', () => {
    const out = redactPII({ note: 'My Aadhaar is 1234 5678 9012 today' });
    expect(out.note).toBe('My Aadhaar is [REDACTED] today');
  });

  it('redacts PAN in free text', () => {
    const out = redactPII({ note: 'PAN is ABCDE1234F maybe' });
    expect(out.note).toBe('PAN is [REDACTED] maybe');
  });

  it('redacts nested structures', () => {
    const out = redactPII({
      user: { mobile: '9876543210', name: 'A' },
      auth: { token: 't' },
      meta: { keep: 'visible' },
    });
    expect(out).toEqual({
      user: { mobile: '[REDACTED]', name: 'A' },
      auth: { token: '[REDACTED]' },
      meta: { keep: 'visible' },
    });
  });

  it('handles arrays', () => {
    const out = redactPII([{ password: 'a' }, { password: 'b' }]);
    expect(out).toEqual([{ password: '[REDACTED]' }, { password: '[REDACTED]' }]);
  });

  it('preserves primitives', () => {
    expect(redactPII(42)).toBe(42);
    expect(redactPII(true)).toBe(true);
    expect(redactPII(null)).toBeNull();
    expect(redactPII(undefined)).toBeUndefined();
  });

  it('does not loop on cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redactPII(a)).not.toThrow();
  });

  it('matches case-insensitively against compound key names', () => {
    const out = redactPII({ AccessKeyID: 'AKIA', JwtAccessSecret: 's' });
    expect(out.AccessKeyID).toBe('[REDACTED]');
    expect(out.JwtAccessSecret).toBe('[REDACTED]');
  });
});
