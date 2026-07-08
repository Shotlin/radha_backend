import { ProductsRepository } from '@/modules/products/products.repository';

import { EanListItemsRepository } from '../repositories/ean-list-items.repository';
import { EanListsRepository } from '../repositories/ean-lists.repository';
import { EanMatcherService } from '../services/ean-matcher.service';
import type { EanListItemRow, EanListRow } from '@/db/schema/ean-lists';

const buildSvc = (
  overrides: {
    activeList?: EanListRow | null;
    itemByEan?: Record<string, EanListItemRow>;
    product?: { id: string; ean: string; name: string };
  } = {},
) => {
  const lists = {
    findActiveForStore: jest.fn().mockResolvedValue(overrides.activeList ?? null),
  } as unknown as EanListsRepository;

  const items = {
    findByListAndEan: jest.fn(
      async (_listId: string, ean: string) => overrides.itemByEan?.[ean] ?? null,
    ),
    findManyByListAndEans: jest.fn(async (_listId: string, eans: string[]) =>
      eans.map((e) => overrides.itemByEan?.[e]).filter((x): x is EanListItemRow => Boolean(x)),
    ),
  } as unknown as EanListItemsRepository;

  const products = {
    findById: jest.fn(async () => overrides.product ?? null),
  } as unknown as ProductsRepository;

  return new EanMatcherService(lists, items, products);
};

describe('EanMatcherService.validate', () => {
  it('rejects format-invalid input', async () => {
    const svc = buildSvc();
    const result = await svc.validate('abc', 'tenant-1', 'store-1');
    expect(result.valid).toBe(false);
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('invalid_format');
  });

  it('returns no_store when storeId is missing', async () => {
    const svc = buildSvc();
    const result = await svc.validate('8901030789885', 'tenant-1', null);
    expect(result.reason).toBe('no_store');
  });

  it('returns no_active_list when no list found', async () => {
    const svc = buildSvc({ activeList: null });
    const result = await svc.validate('8901030789885', 'tenant-1', 'store-1');
    expect(result.reason).toBe('no_active_list');
  });

  it('returns not_in_list when list exists but item missing', async () => {
    const svc = buildSvc({
      activeList: { id: 'list-1' } as EanListRow,
      itemByEan: {},
    });
    const result = await svc.validate('8901030789885', 'tenant-1', 'store-1');
    expect(result.reason).toBe('not_in_list');
  });

  it('returns matched=true with linked listItem when found', async () => {
    const item = {
      id: 'item-1',
      listId: 'list-1',
      ean: '8901030789885',
      productId: 'p-1',
    } as EanListItemRow;
    const svc = buildSvc({
      activeList: { id: 'list-1' } as EanListRow,
      itemByEan: { '8901030789885': item },
      product: { id: 'p-1', ean: '8901030789885', name: 'Maggi' },
    });
    const result = await svc.validate('8901030789885', 'tenant-1', 'store-1');
    expect(result.valid).toBe(true);
    expect(result.matched).toBe(true);
    expect(result.listItem?.id).toBe('item-1');
    expect(result.product?.id).toBe('p-1');
  });

  it('normalises UPC-A to EAN-13 before lookup', async () => {
    const item = {
      id: 'item-1',
      listId: 'list-1',
      ean: '0614141000043',
      productId: null,
    } as EanListItemRow;
    const svc = buildSvc({
      activeList: { id: 'list-1' } as EanListRow,
      itemByEan: { '0614141000043': item },
    });
    const result = await svc.validate('614141000043', 'tenant-1', 'store-1');
    expect(result.valid).toBe(true);
    expect(result.ean).toBe('0614141000043');
  });
});

describe('EanMatcherService.validateBatch', () => {
  it('produces a Map keyed by ORIGINAL input even when normalisation collides', async () => {
    const item = {
      id: 'item-1',
      listId: 'list-1',
      ean: '0614141000043',
      productId: null,
    } as EanListItemRow;
    const svc = buildSvc({
      activeList: { id: 'list-1' } as EanListRow,
      itemByEan: { '0614141000043': item },
    });
    const map = await svc.validateBatch(
      ['614141000043', '0614141000043', '0614141000044'],
      'tenant-1',
      'store-1',
    );
    expect(map.get('614141000043')?.matched).toBe(true);
    expect(map.get('0614141000043')?.matched).toBe(true);
    expect(map.get('0614141000044')?.reason).toBe('invalid_format');
  });

  it('returns no_store for every entry when storeId is null', async () => {
    const svc = buildSvc();
    const map = await svc.validateBatch(['8901030789885', '8901030789888'], 'tenant-1', null);
    for (const v of map.values()) {
      expect(v.reason).toBe('no_store');
    }
  });

  it('returns no_active_list for every entry when no list', async () => {
    const svc = buildSvc({ activeList: null });
    const map = await svc.validateBatch(['8901030789885'], 'tenant-1', 'store-1');
    expect(map.get('8901030789885')?.reason).toBe('no_active_list');
  });

  it('returns empty Map for empty input', async () => {
    const svc = buildSvc();
    const map = await svc.validateBatch([], 'tenant-1', 'store-1');
    expect(map.size).toBe(0);
  });
});
