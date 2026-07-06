import { Injectable } from '@nestjs/common';

import type { ExpiryStatus } from '../types/expiry.types';
import {
  ThresholdLike,
  calculateExpiryStatus,
  daysUntilExpiry,
  statusColor,
} from '../utils/expiry-rules.utils';

/**
 * BE-18 — Expiry calculator. Thin Nest wrapper over the pure
 * helpers in `expiry-rules.utils.ts` so consumers can DI it but the
 * logic stays unit-testable in isolation.
 */
@Injectable()
export class ExpiryCalculatorService {
  calculateStatus(
    expiryDate: Date | null | undefined,
    threshold: ThresholdLike,
    referenceDate: Date = new Date(),
  ): ExpiryStatus {
    return calculateExpiryStatus(expiryDate, threshold, referenceDate);
  }

  daysUntilExpiry(
    expiryDate: Date | null | undefined,
    referenceDate: Date = new Date(),
  ): number | null {
    return daysUntilExpiry(expiryDate, referenceDate);
  }

  isExpired(expiryDate: Date | null | undefined, referenceDate: Date = new Date()): boolean {
    const days = daysUntilExpiry(expiryDate, referenceDate);
    return days !== null && days < 0;
  }

  statusColor(status: ExpiryStatus): 'green' | 'yellow' | 'red' | 'gray' {
    return statusColor(status);
  }
}
