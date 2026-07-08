import { detectFileType, validateAgainstDeclaredType } from '../utils/file-detector.utils';

const xlsxBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const xlsLegacyBytes = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const csvBytes = Buffer.from('ean,name,brand\n1234567890128,Foo,Cadbury\n', 'utf8');

describe('detectFileType', () => {
  it('detects xlsx by ZIP magic header', () => {
    expect(detectFileType(xlsxBytes)).toBe('xlsx');
  });

  it('detects xls-legacy and rejects it', () => {
    expect(detectFileType(xlsLegacyBytes)).toBe('xls-legacy');
  });

  it('detects csv when at least one delimiter is present', () => {
    expect(detectFileType(csvBytes)).toBe('csv');
  });

  it('returns unknown when buffer is too short', () => {
    expect(detectFileType(Buffer.from([0x01, 0x02]))).toBe('unknown');
  });

  it('returns unknown for binary blob with no delimiters', () => {
    const blob = Buffer.from([0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88]);
    expect(detectFileType(blob)).toBe('unknown');
  });
});

describe('validateAgainstDeclaredType', () => {
  it('passes when xlsx declared and detected', () => {
    expect(validateAgainstDeclaredType(xlsxBytes, 'xlsx')).toEqual({ ok: true });
  });

  it('passes when csv declared and detected', () => {
    expect(validateAgainstDeclaredType(csvBytes, 'csv')).toEqual({ ok: true });
  });

  it('rejects xlsx-declared CSV bytes with mismatch reason', () => {
    const result = validateAgainstDeclaredType(csvBytes, 'xlsx');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('does not match');
  });

  it('rejects legacy .xls explicitly', () => {
    const result = validateAgainstDeclaredType(xlsLegacyBytes, 'xlsx');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Legacy .xls');
  });

  it('rejects unknown bytes', () => {
    const result = validateAgainstDeclaredType(Buffer.from([0x01, 0x02, 0x03, 0x04]), 'csv');
    expect(result.ok).toBe(false);
  });
});
