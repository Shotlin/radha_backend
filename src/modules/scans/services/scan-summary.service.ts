import { Injectable } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';

import { ScanItemsRepository } from '../repositories/scan-items.repository';
import { ScanSessionsRepository } from '../repositories/scan-sessions.repository';
import type { SessionSummary } from '../types/scan.types';
import { calculateScanRate } from '../utils/scan-stats.utils';

/**
 * BE-16 — Session summary builder. Reads the canonical aggregate
 * from `scan_items` (so a drifted denormalised counter doesn't lie)
 * and computes rate + warnings from there.
 */
@Injectable()
export class ScanSummaryService {
  constructor(
    private readonly sessionsRepo: ScanSessionsRepository,
    private readonly itemsRepo: ScanItemsRepository,
  ) {}

  async forSession(sessionId: string, tenantId: string): Promise<SessionSummary> {
    const session = await this.sessionsRepo.findByIdInTenant(sessionId, tenantId);
    if (!session) throw new DomainNotFoundException('ScanSession', sessionId);

    const aggregate = await this.itemsRepo.aggregateForSession(sessionId);
    const startedAt = session.startedAt;
    const endedAt = session.endedAt;
    const scanRate = calculateScanRate({
      totalScans: aggregate.totalScans,
      startedAt,
      endedAt,
    });
    const durationSeconds = Math.floor(
      ((endedAt ?? new Date()).getTime() - startedAt.getTime()) / 1000,
    );
    return {
      sessionId,
      totalScans: aggregate.totalScans,
      uniqueProducts: aggregate.uniqueProducts,
      matchedEans: aggregate.matchedEans,
      unmatchedEans: aggregate.unmatchedEans,
      expiredItems: aggregate.expiredItems,
      nearExpiryItems: aggregate.nearExpiryItems,
      warningsCount: aggregate.unmatchedEans + aggregate.expiredItems + aggregate.nearExpiryItems,
      durationSeconds,
      scanRate,
    };
  }
}
