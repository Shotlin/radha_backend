import { Injectable } from '@nestjs/common';

import type { ShoppingListItemRow, ShoppingListRow } from '@/db/schema/shopping-lists';

import type { WhatsAppFormatResponseDto } from '../dto/whatsapp-format.dto';

/**
 * BE-55 — WhatsApp formatter.
 *
 * Renders a shopping list as plain text (the format the user sees in
 * WhatsApp) and packages it into a `wa.me` deep link the mobile app
 * can launch directly.
 *
 * Rules per the BE-55 spec:
 *   - The first line is the list `name` rendered as a header.
 *   - Each item line is `- {item} ({quantity})`. The quantity
 *     parenthetical is omitted when no quantity is set.
 *   - Purchased items are prefixed with `✓ `, e.g. `✓ - Bread`.
 *   - The text is then `encodeURIComponent`-ed and appended to
 *     `https://wa.me/?text=...` (or `https://wa.me/{phone}?text=...`
 *     when a recipient phone is provided).
 *
 * The service is purely functional — no DB access, no side effects —
 * so it's trivially unit-testable.
 */

const WA_BASE_URL = 'https://wa.me';
const PURCHASED_PREFIX = '✓ ';

export interface WhatsAppFormatOptions {
  /**
   * Whether to include items where `is_purchased` is `true`. Defaults
   * to `true` because the most common share flow is "send my whole
   * list" — but consumers who want to share only the still-needed
   * items can flip this off.
   */
  includePurchased?: boolean;
  /**
   * Optional E.164 phone number for the share recipient. When
   * provided, the URL targets that contact directly via
   * `https://wa.me/{phone}?text=...`. When omitted, WhatsApp prompts
   * the user to pick from their address book.
   */
  phone?: string;
}

@Injectable()
export class WhatsAppFormatterService {
  /**
   * Build the `{ text, shareUrl }` envelope for a list.
   *
   * Caller is responsible for filtering out soft-deleted items —
   * this service only sees the rows handed to it.
   */
  format(
    list: Pick<ShoppingListRow, 'name'>,
    items: ShoppingListItemRow[],
    options: WhatsAppFormatOptions = {},
  ): WhatsAppFormatResponseDto {
    const text = this.buildText(list, items, options);
    const shareUrl = this.buildShareUrl(text, options.phone);
    return { text, shareUrl };
  }

  /** Render just the text portion. Exposed for tests / clipboard share. */
  buildText(
    list: Pick<ShoppingListRow, 'name'>,
    items: ShoppingListItemRow[],
    options: WhatsAppFormatOptions = {},
  ): string {
    const includePurchased = options.includePurchased ?? true;
    const filtered = items.filter((item) => includePurchased || !item.isPurchased);

    const lines: string[] = [list.name.trim() || 'Shopping List'];
    if (filtered.length === 0) {
      // Keep the header alone for an empty list — easier to spot than
      // trailing whitespace, and the share link still works.
      return lines.join('\n');
    }

    for (const item of filtered) {
      lines.push(this.renderItemLine(item));
    }
    return lines.join('\n');
  }

  /** Construct the `wa.me` URL with the text URL-encoded. */
  buildShareUrl(text: string, phone?: string): string {
    const encoded = encodeURIComponent(text);
    const recipient = this.normalisePhone(phone);
    return recipient
      ? `${WA_BASE_URL}/${recipient}?text=${encoded}`
      : `${WA_BASE_URL}/?text=${encoded}`;
  }

  /**
   * `- {item} ({quantity})`, prefixed with `✓ ` for purchased rows.
   * Whitespace is trimmed and an empty `quantity` is treated as
   * absent so we never render `- Milk ()`.
   */
  private renderItemLine(item: ShoppingListItemRow): string {
    const itemText = (item.item ?? '').trim();
    const quantity = item.quantity?.trim();
    const body = quantity ? `- ${itemText} (${quantity})` : `- ${itemText}`;
    return item.isPurchased ? `${PURCHASED_PREFIX}${body}` : body;
  }

  /**
   * `wa.me` accepts the recipient as digits only (with or without a
   * leading `+`). Strip everything that isn't a digit to keep the URL
   * canonical. Returns `undefined` when the input ends up empty so
   * the caller falls back to the `/` (no-recipient) variant.
   */
  private normalisePhone(phone?: string): string | undefined {
    if (!phone) return undefined;
    const digits = phone.replace(/\D+/g, '');
    return digits.length > 0 ? digits : undefined;
  }
}
