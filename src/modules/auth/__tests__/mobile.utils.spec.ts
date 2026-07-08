import { ValidationException } from '@/common/errors/business.exception';

import { maskMobile, normaliseMobile } from '../utils/mobile.utils';

describe('normaliseMobile', () => {
  it.each([
    ['9876543210', '9876543210'],
    ['+91 98765 43210', '9876543210'],
    ['09876543210', '9876543210'],
    ['+919876543210', '9876543210'],
    ['98765-43210', '9876543210'],
  ])('normalises %s → %s', (input, expected) => {
    expect(normaliseMobile(input)).toBe(expected);
  });

  it.each(['1234567890', 'abc', '+91 12345', '12345678901234'])('rejects %s', (bad) => {
    expect(() => normaliseMobile(bad)).toThrow(ValidationException);
  });
});

describe('maskMobile', () => {
  it('keeps the leading two and trailing two digits', () => {
    expect(maskMobile('9876543210')).toBe('98******10');
  });

  it('returns [masked] for non-canonical input', () => {
    expect(maskMobile('123')).toBe('[masked]');
  });
});
