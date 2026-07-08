import { extractRowFields } from '../services/row-mapper.utils';

describe('extractRowFields', () => {
  it('extracts canonical lower-case keys', () => {
    const result = extractRowFields({
      ean: '8901030789885',
      name: 'Maggi 2-Minute Noodles',
      brand: 'Nestle',
      notes: 'Pack of 12',
    });
    expect(result).toEqual({
      ean: '8901030789885',
      productName: 'Maggi 2-Minute Noodles',
      brand: 'Nestle',
      notes: 'Pack of 12',
    });
  });

  it('handles upper-case headers (Excel default)', () => {
    expect(
      extractRowFields({
        EAN: '8901030789885',
        Name: 'Maggi',
        Brand: 'Nestle',
      }),
    ).toEqual({
      ean: '8901030789885',
      productName: 'Maggi',
      brand: 'Nestle',
      notes: undefined,
    });
  });

  it('matches synonyms (Barcode, GTIN, Manufacturer, Description)', () => {
    expect(
      extractRowFields({
        Barcode: '8901030789885',
        Description: 'Pack of 12',
        Manufacturer: 'Nestle India',
      }),
    ).toEqual({
      ean: '8901030789885',
      productName: 'Pack of 12',
      brand: 'Nestle India',
      notes: undefined,
    });
  });

  it('is whitespace-tolerant on header keys', () => {
    expect(
      extractRowFields({
        '  Product Name  ': 'Maggi',
        'Bar Code': '8901030789885',
      }),
    ).toEqual({
      ean: '8901030789885',
      productName: 'Maggi',
      brand: undefined,
      notes: undefined,
    });
  });

  it('returns empty ean when no candidate matches', () => {
    expect(extractRowFields({ random_column: 'foo' })).toEqual({
      ean: '',
      productName: undefined,
      brand: undefined,
      notes: undefined,
    });
  });

  it('skips empty-string values', () => {
    expect(
      extractRowFields({
        ean: '8901030789885',
        name: '',
        brand: '   ',
      }),
    ).toEqual({
      ean: '8901030789885',
      productName: undefined,
      brand: undefined,
      notes: undefined,
    });
  });
});
