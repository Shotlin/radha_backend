/**
 * EAN / UPC validation + normalisation.
 *
 * RADHA stores all barcodes as 13-digit EAN-13 strings. This file is
 * the only place that knows how to:
 *   - detect the input format,
 *   - validate the GS1 mod-10 check digit,
 *   - expand UPC-E → UPC-A → EAN-13.
 *
 * Pure functions, no I/O — safe to call from anywhere including the
 * shared types layer if we ever need it.
 */

export type EanFormat = 'EAN-8' | 'EAN-13' | 'UPC-A' | 'UPC-E' | 'INVALID';

const onlyDigits = (input: string): string => input.replace(/\D/g, '');

export const detectEanFormat = (raw: string): EanFormat => {
  const digits = onlyDigits(raw);
  switch (digits.length) {
    case 8:
      return 'EAN-8';
    case 12:
      return 'UPC-A';
    case 13:
      return 'EAN-13';
    case 6:
      return 'UPC-E';
    default:
      return 'INVALID';
  }
};

const calcEan13Check = (first12: string): number => {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const d = first12.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
};

const calcEan8Check = (first7: string): number => {
  let sum = 0;
  for (let i = 0; i < 7; i += 1) {
    const d = first7.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
};

const calcUpcACheck = (first11: string): number => {
  let sum = 0;
  for (let i = 0; i < 11; i += 1) {
    const d = first11.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
};

/**
 * UPC-E expansion to UPC-A. Implements the standard 6 → 12 algorithm.
 * Returns 12-digit UPC-A; subsequent normalisation prepends '0' to
 * reach EAN-13.
 */
const expandUpcE = (upcE: string): string => {
  if (upcE.length !== 6) return upcE;
  const last = upcE[5];
  const f = upcE.slice(0, 5);
  let first11: string;
  switch (last) {
    case '0':
    case '1':
    case '2':
      first11 = `0${f.slice(0, 2)}${last}0000${f.slice(2)}`;
      break;
    case '3':
      first11 = `0${f.slice(0, 3)}00000${f.slice(3)}`;
      break;
    case '4':
      first11 = `0${f.slice(0, 4)}00000${f.slice(4)}`;
      break;
    default:
      first11 = `0${f}0000${last}`;
  }
  const check = calcUpcACheck(first11);
  return `${first11}${check}`;
};

export interface EanValidationResult {
  valid: boolean;
  format: EanFormat;
  normalised?: string;
  error?: string;
}

export const validateEan = (raw: string): EanValidationResult => {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { valid: false, format: 'INVALID', error: 'EAN is required' };
  }
  const digits = onlyDigits(raw);
  const format = detectEanFormat(digits);
  if (format === 'INVALID') {
    return {
      valid: false,
      format,
      error: `Invalid EAN length: ${digits.length}. Expected 6, 8, 12, or 13 digits.`,
    };
  }

  if (format === 'EAN-13') {
    const expected = calcEan13Check(digits.slice(0, 12));
    if (Number(digits[12]) !== expected) {
      return { valid: false, format, error: 'Invalid EAN-13 check digit' };
    }
  }
  if (format === 'EAN-8') {
    const expected = calcEan8Check(digits.slice(0, 7));
    if (Number(digits[7]) !== expected) {
      return { valid: false, format, error: 'Invalid EAN-8 check digit' };
    }
  }
  if (format === 'UPC-A') {
    const expected = calcUpcACheck(digits.slice(0, 11));
    if (Number(digits[11]) !== expected) {
      return { valid: false, format, error: 'Invalid UPC-A check digit' };
    }
  }

  return { valid: true, format, normalised: normaliseEan(digits) };
};

export const normaliseEan = (raw: string): string => {
  const digits = onlyDigits(raw);
  if (digits.length === 13) return digits;
  if (digits.length === 12) return `0${digits}`;
  if (digits.length === 8) return digits; // EAN-8 stays as-is in storage
  if (digits.length === 6) {
    const upcA = expandUpcE(digits);
    return `0${upcA}`;
  }
  return digits;
};
