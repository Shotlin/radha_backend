import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { SavedProductRow } from '@/db/schema/saved-products';

import {
  CalendarDay,
  CalendarMonthResponse,
  CalendarMonthSummary,
  CalendarProduct,
  ExpiryColor,
  EXPIRY_COLOR_THRESHOLDS,
  IST_OFFSET_MS,
} from '../types/expiry-calendar.types';
import { ExpiryCalendarRepository } from '../expiry-calendar.repository';
import { FamilySharingRepository } from '../repositories/family-sharing-lookup.repository';

/**
 * BE-38 — Expiry Calendar service.
 *
 * Aggregates saved products by day for a given month,
 * applies color-coding, and supports family-sharing union for Premium users.
 */
@Injectable()
export class ExpiryCalendarService {
  private readonly logger = new Logger(ExpiryCalendarService.name);

  constructor(
    private readonly repo: ExpiryCalendarRepository,
    private readonly familyRepo: FamilySharingRepository,
  ) {}

  /**
   * Retrieve the calendar for a given YYYY-MM month.
   * Premium consumers see their own + family members' products.
   */
  async byMonth(
    userId: string,
    month: string,
    isPremium: boolean,
  ): Promise<CalendarMonthResponse> {
    const { startDate, endDate } = this.getMonthRange(month);

    let products: SavedProductRow[];

    if (isPremium) {
      const familyUserIds = await this.familyRepo.getAcceptedFamilyUserIds(userId);
      const allUserIds = [userId, ...familyUserIds];
      products = await this.repo.findActiveByUsersInRange(allUserIds, startDate, endDate);
    } else {
      products = await this.repo.findActiveByUserInRange(userId, startDate, endDate);
    }

    return this.buildCalendarResponse(month, products);
  }

  /**
   * Mark a saved product as consumed.
   * Only the owner can mark their own product.
   */
  async markConsumed(
    userId: string,
    productId: string,
    isPremium: boolean,
  ): Promise<{ id: string; markedConsumedAt: string }> {
    const allowedUserIds = await this.getAllowedUserIds(userId, isPremium);
    const product = await this.repo.findByIdForUsers(productId, allowedUserIds);

    if (!product) {
      throw new NotFoundException('Saved product not found');
    }

    if (product.userId !== userId) {
      throw new ForbiddenException('Only the product owner can mark it as consumed');
    }

    const updated = await this.repo.markConsumed(productId);
    if (!updated) {
      throw new NotFoundException('Saved product not found');
    }

    return {
      id: updated.id,
      markedConsumedAt: updated.markedConsumedAt!.toISOString(),
    };
  }

  /**
   * Remove a saved product entirely.
   * Only the owner can remove their own product.
   */
  async remove(userId: string, productId: string, isPremium: boolean): Promise<{ id: string; removed: boolean }> {
    const allowedUserIds = await this.getAllowedUserIds(userId, isPremium);
    const product = await this.repo.findByIdForUsers(productId, allowedUserIds);

    if (!product) {
      throw new NotFoundException('Saved product not found');
    }

    if (product.userId !== userId) {
      throw new ForbiddenException('Only the product owner can remove it');
    }

    const removed = await this.repo.remove(productId);
    return { id: productId, removed };
  }

  /* ─────────────── Private helpers ─────────────── */

  private async getAllowedUserIds(userId: string, isPremium: boolean): Promise<string[]> {
    if (!isPremium) return [userId];
    const familyUserIds = await this.familyRepo.getAcceptedFamilyUserIds(userId);
    return [userId, ...familyUserIds];
  }

  /**
   * Get the start and end dates for a given YYYY-MM month in IST.
   */
  private getMonthRange(month: string): { startDate: string; endDate: string } {
    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr, 10);
    const monthNum = parseInt(monthStr, 10);

    const startDate = `${year}-${monthStr}-01`;

    // Last day of the month
    const lastDay = new Date(year, monthNum, 0).getDate();
    const endDate = `${year}-${monthStr}-${String(lastDay).padStart(2, '0')}`;

    return { startDate, endDate };
  }

  /**
   * Build the full calendar response from a list of saved products.
   */
  private buildCalendarResponse(month: string, products: SavedProductRow[]): CalendarMonthResponse {
    const today = this.getTodayIST();
    const dayMap = new Map<string, CalendarProduct[]>();

    for (const product of products) {
      if (!product.expiresAt) continue;

      const dateStr =
        typeof product.expiresAt === 'string'
          ? product.expiresAt
          : (product.expiresAt as Date).toISOString().split('T')[0];

      const daysUntilExpiry = this.daysBetween(today, dateStr);
      const color = this.getColor(daysUntilExpiry);

      const calendarProduct: CalendarProduct = {
        id: product.id,
        productName: product.productName,
        productId: product.productId ?? null,
        barcode: product.barcode ?? null,
        expiresAt: dateStr,
        color,
        daysUntilExpiry,
        notes: product.notes ?? null,
        userId: product.userId,
      };

      const existing = dayMap.get(dateStr) ?? [];
      existing.push(calendarProduct);
      dayMap.set(dateStr, existing);
    }

    // Build days array (sorted)
    const days: CalendarDay[] = Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, prods]) => ({
        date,
        count: prods.length,
        dominantColor: this.getDominantColor(prods),
        products: prods,
      }));

    // Build summary
    const summary = this.buildSummary(products, today);

    return {
      month,
      totalProducts: products.length,
      summary,
      days,
    };
  }

  /**
   * Calculate the number of days between today and a target date.
   * Positive = future, negative = past (expired).
   */
  private daysBetween(today: string, targetDate: string): number {
    const todayMs = new Date(today).getTime();
    const targetMs = new Date(targetDate).getTime();
    return Math.floor((targetMs - todayMs) / (1000 * 60 * 60 * 24));
  }

  /**
   * Get color based on days until expiry.
   */
  getColor(daysUntilExpiry: number): ExpiryColor {
    if (daysUntilExpiry < EXPIRY_COLOR_THRESHOLDS.RED_DAYS) return 'red';
    if (daysUntilExpiry <= EXPIRY_COLOR_THRESHOLDS.YELLOW_DAYS) return 'yellow';
    return 'green';
  }

  /**
   * Determine the dominant color for a day (worst case wins).
   */
  private getDominantColor(products: CalendarProduct[]): ExpiryColor {
    if (products.some((p) => p.color === 'red')) return 'red';
    if (products.some((p) => p.color === 'yellow')) return 'yellow';
    return 'green';
  }

  /**
   * Build the summary counts.
   */
  private buildSummary(products: SavedProductRow[], today: string): CalendarMonthSummary {
    let green = 0;
    let yellow = 0;
    let red = 0;
    let expired = 0;

    for (const product of products) {
      if (!product.expiresAt) continue;
      const dateStr =
        typeof product.expiresAt === 'string'
          ? product.expiresAt
          : (product.expiresAt as Date).toISOString().split('T')[0];

      const days = this.daysBetween(today, dateStr);

      if (days < 0) {
        expired++;
      } else if (days < EXPIRY_COLOR_THRESHOLDS.RED_DAYS) {
        red++;
      } else if (days <= EXPIRY_COLOR_THRESHOLDS.YELLOW_DAYS) {
        yellow++;
      } else {
        green++;
      }
    }

    return { green, yellow, red, expired };
  }

  /**
   * Get today's date string in IST (YYYY-MM-DD).
   */
  getTodayIST(): string {
    const now = new Date();
    const istTime = new Date(now.getTime() + IST_OFFSET_MS);
    return istTime.toISOString().split('T')[0];
  }
}
