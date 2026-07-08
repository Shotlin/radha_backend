import type { ShoppingListItemRow, ShoppingListRow } from '@/db/schema/shopping-lists';

import { WhatsAppFormatterService } from '../services/whatsapp-formatter.service';

/**
 * BE-55 — `WhatsAppFormatterService` unit tests.
 *
 * Locks down the wire format the BE-55 spec describes:
 *   - first line is the list name (header),
 *   - each line is `- {item} ({quantity})` (parens omitted when no
 *     quantity),
 *   - purchased items are prefixed with `✓ `,
 *   - the share URL is `https://wa.me/?text={encoded}` (or
 *     `https://wa.me/{phone}?text={encoded}` when a phone is given),
 *   - the text is `encodeURIComponent`-ed.
 */
describe('WhatsAppFormatterService', () => {
  let service: WhatsAppFormatterService;

  const list: Pick<ShoppingListRow, 'name'> = { name: 'Weekly Groceries' };

  const buildItem = (overrides: Partial<ShoppingListItemRow> = {}): ShoppingListItemRow => ({
    id: '11111111-1111-1111-1111-111111111111',
    listId: '22222222-2222-2222-2222-222222222222',
    item: 'Milk',
    quantity: '2L',
    notes: null,
    isPurchased: false,
    position: 0,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    service = new WhatsAppFormatterService();
  });

  describe('buildText', () => {
    it('renders the list name as the first line', () => {
      const text = service.buildText(list, [buildItem()]);
      expect(text.split('\n')[0]).toBe('Weekly Groceries');
    });

    it('formats lines as "- {item} ({quantity})"', () => {
      const text = service.buildText(list, [
        buildItem({ item: 'Milk', quantity: '2L' }),
        buildItem({ id: 'item-2', item: 'Bread', quantity: '1 loaf' }),
      ]);
      expect(text).toBe('Weekly Groceries\n- Milk (2L)\n- Bread (1 loaf)');
    });

    it('omits the parenthetical when quantity is null/empty', () => {
      const text = service.buildText(list, [
        buildItem({ item: 'Milk', quantity: null }),
        buildItem({ id: 'item-2', item: 'Bread', quantity: '   ' }),
      ]);
      expect(text).toBe('Weekly Groceries\n- Milk\n- Bread');
    });

    it('prefixes purchased items with the ✓ marker', () => {
      const text = service.buildText(list, [
        buildItem({ item: 'Milk', quantity: '2L', isPurchased: true }),
        buildItem({ id: 'item-2', item: 'Bread', quantity: null, isPurchased: false }),
      ]);
      expect(text).toBe('Weekly Groceries\n✓ - Milk (2L)\n- Bread');
    });

    it('drops purchased items when includePurchased=false', () => {
      const text = service.buildText(
        list,
        [
          buildItem({ item: 'Milk', isPurchased: true, quantity: null }),
          buildItem({ id: 'item-2', item: 'Bread', isPurchased: false, quantity: null }),
        ],
        { includePurchased: false },
      );
      expect(text).toBe('Weekly Groceries\n- Bread');
    });

    it('keeps just the header for an empty (or fully filtered) list', () => {
      expect(service.buildText(list, [])).toBe('Weekly Groceries');
      const filtered = service.buildText(list, [buildItem({ isPurchased: true, quantity: null })], {
        includePurchased: false,
      });
      expect(filtered).toBe('Weekly Groceries');
    });

    it('falls back to "Shopping List" when the name is blank', () => {
      const text = service.buildText({ name: '   ' }, [buildItem({ quantity: null })]);
      expect(text).toBe('Shopping List\n- Milk');
    });
  });

  describe('buildShareUrl', () => {
    it('encodes the text into the wa.me URL', () => {
      const text = 'Weekly Groceries\n- Milk (2L)';
      const url = service.buildShareUrl(text);
      expect(url).toBe(`https://wa.me/?text=${encodeURIComponent(text)}`);
    });

    it('preserves emoji and unicode round-trips through encoding', () => {
      const text = 'List\n✓ - Bread';
      const url = service.buildShareUrl(text);
      expect(url).toContain(encodeURIComponent('✓'));
      expect(decodeURIComponent(url.split('?text=')[1])).toBe(text);
    });

    it('targets a specific phone when provided (digits only)', () => {
      const url = service.buildShareUrl('hi', '+91 98765 43210');
      expect(url).toBe(`https://wa.me/919876543210?text=${encodeURIComponent('hi')}`);
    });

    it('falls back to the no-recipient form when phone is empty/whitespace', () => {
      expect(service.buildShareUrl('hi', '')).toBe(
        `https://wa.me/?text=${encodeURIComponent('hi')}`,
      );
      expect(service.buildShareUrl('hi', '   ')).toBe(
        `https://wa.me/?text=${encodeURIComponent('hi')}`,
      );
    });
  });

  describe('format', () => {
    it('returns both text and shareUrl in the envelope', () => {
      const result = service.format(list, [buildItem({ quantity: null })]);
      expect(result.text).toBe('Weekly Groceries\n- Milk');
      expect(result.shareUrl).toBe(`https://wa.me/?text=${encodeURIComponent(result.text)}`);
    });

    it('honours includePurchased and phone options together', () => {
      const result = service.format(
        list,
        [
          buildItem({ item: 'Milk', isPurchased: true, quantity: null }),
          buildItem({ id: 'i2', item: 'Bread', quantity: null }),
        ],
        { includePurchased: false, phone: '919876543210' },
      );
      expect(result.text).toBe('Weekly Groceries\n- Bread');
      expect(result.shareUrl).toBe(
        `https://wa.me/919876543210?text=${encodeURIComponent(result.text)}`,
      );
    });
  });
});
