import type { FileType } from '../types/import.types';

/**
 * BE-15 — file-type detection.
 *
 * The Mobile_App / dashboard tells us the file type via the DTO, but
 * we still verify by sniffing magic bytes to prevent a CSV labelled
 * `xlsx` (or vice-versa) from running through the wrong parser.
 *
 *   xlsx — ZIP archive header `PK` (50 4B) — XLSX is a ZIP of XML files.
 *   xls  — D0 CF 11 E0 (legacy compound binary)  — we DO NOT support.
 *   csv  — anything else; sniff for at least one delimiter.
 */

export const detectFileType = (buffer: Buffer): FileType | 'xls-legacy' | 'unknown' => {
  if (buffer.length < 4) return 'unknown';

  // XLSX → ZIP (PK\x03\x04 header)
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return 'xlsx';
  }
  // Legacy XLS (compound binary) → reject loudly so caller knows.
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    return 'xls-legacy';
  }

  // CSV fallback — must contain at least one delimiter in the first 1 KB.
  const sample = buffer.subarray(0, Math.min(1024, buffer.length)).toString('utf8');
  if (/[,;\t]/.test(sample)) return 'csv';

  return 'unknown';
};

export const validateAgainstDeclaredType = (
  buffer: Buffer,
  declared: FileType,
): { ok: true } | { ok: false; reason: string } => {
  const detected = detectFileType(buffer);
  if (detected === 'xls-legacy') {
    return {
      ok: false,
      reason: 'Legacy .xls files are not supported. Save as .xlsx and re-upload.',
    };
  }
  if (detected === 'unknown') {
    return { ok: false, reason: 'File format could not be detected' };
  }
  if (detected !== declared) {
    return {
      ok: false,
      reason: `Declared file type ${declared} does not match detected ${detected}`,
    };
  }
  return { ok: true };
};
