import { ValidationException } from '@/common/errors/business.exception';

/**
 * Indian mobile-number normalisation.
 *
 * Stored canonical form is the bare 10-digit number (no +91, no
 * spaces). The Mobile_App can submit any of:
 *   `+91 98765 43210`, `9876543210`, `+919876543210`, `09876543210`
 * and we'll fold all of them to `9876543210`.
 *
 * Throws `ValidationException` so the global exception filter renders
 * the standard envelope.
 */

const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/;

export const normaliseMobile = (input: string): string => {
  if (typeof input !== 'string') {
    throw new ValidationException('Mobile number must be a string', { field: 'mobile' });
  }
  const digits = input.replace(/\D/g, '');
  let bare: string | undefined;
  if (digits.length === 10) bare = digits;
  else if (digits.length === 12 && digits.startsWith('91')) bare = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) bare = digits.slice(1);

  if (!bare || !INDIAN_MOBILE_RE.test(bare)) {
    throw new ValidationException('Invalid Indian mobile number', {
      field: 'mobile',
      value: input,
    });
  }
  return bare;
};

export const maskMobile = (mobile: string): string =>
  mobile.length === 10 ? `${mobile.slice(0, 2)}******${mobile.slice(-2)}` : '[masked]';
