/**
 * Column-name resolution. Spreadsheets in the wild use a wild variety
 * of header names; this resolver picks the first match for each
 * canonical field. Case-insensitive, whitespace-tolerant.
 */
const EAN_KEYS = [
  'ean',
  'eans',
  'barcode',
  'bar code',
  'gtin',
  'code',
  'product code',
  'product_code',
];
const NAME_KEYS = [
  'name',
  'product name',
  'product_name',
  'productname',
  'item',
  'description',
  'product',
];
const BRAND_KEYS = ['brand', 'manufacturer', 'maker', 'company'];
const NOTES_KEYS = ['notes', 'remarks', 'comments', 'note', 'remark', 'comment'];

const normaliseKey = (key: string): string => key.toLowerCase().trim().replace(/\s+/g, ' ');

const resolveValue = (
  row: Record<string, string>,
  candidates: ReadonlyArray<string>,
): string | undefined => {
  // Build a case-insensitive lookup once.
  const lookup = new Map<string, string>();
  for (const [k, v] of Object.entries(row)) {
    if (typeof v !== 'string') continue;
    lookup.set(normaliseKey(k), v.trim());
  }
  for (const cand of candidates) {
    const v = lookup.get(normaliseKey(cand));
    if (v !== undefined && v.length > 0) return v;
  }
  return undefined;
};

export interface ExtractedRow {
  ean: string;
  productName?: string;
  brand?: string;
  notes?: string;
}

export const extractRowFields = (row: Record<string, string>): ExtractedRow => {
  return {
    ean: resolveValue(row, EAN_KEYS) ?? '',
    productName: resolveValue(row, NAME_KEYS),
    brand: resolveValue(row, BRAND_KEYS),
    notes: resolveValue(row, NOTES_KEYS),
  };
};
