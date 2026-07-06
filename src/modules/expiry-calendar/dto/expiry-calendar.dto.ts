import { IsOptional, IsString, Matches } from 'class-validator';
import { z } from 'zod';

/* ─────────────────── Query DTOs ─────────────────── */

export class ExpiryCalendarMonthQueryDto {
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month must be in YYYY-MM format',
  })
  month!: string;
}

export const ExpiryCalendarMonthQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be in YYYY-MM format'),
});

/* ─────────────────── Response DTOs ─────────────────── */

export type ExpiryColor = 'green' | 'yellow' | 'red';

export interface CalendarProductDto {
  id: string;
  productName: string;
  productId: string | null;
  barcode: string | null;
  expiresAt: string; // ISO date string (YYYY-MM-DD)
  color: ExpiryColor;
  daysUntilExpiry: number;
  notes: string | null;
  userId: string;
}

export interface CalendarDayDto {
  date: string; // ISO date string (YYYY-MM-DD)
  count: number;
  dominantColor: ExpiryColor;
  products: CalendarProductDto[];
}

export interface ExpiryCalendarMonthDto {
  month: string; // YYYY-MM
  totalProducts: number;
  summary: {
    green: number;
    yellow: number;
    red: number;
    expired: number;
  };
  days: CalendarDayDto[];
}

export interface MarkConsumedResponseDto {
  id: string;
  markedConsumedAt: string;
}

export interface RemoveResponseDto {
  id: string;
  removed: boolean;
}
