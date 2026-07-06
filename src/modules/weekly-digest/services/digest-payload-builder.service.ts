import { Inject, Injectable } from '@nestjs/common';

import {
  weeklyDigestPayloadSchema,
  type WeeklyDigestPayload,
} from '../dto/weekly-digest.dto';
import { IScansSourcePort, SCANS_SOURCE_TOKEN } from '../ports/scans-source.port';

/**
 * BE-54 — Digest payload builder.
 *
 * Sole responsibility is to take a (user, week-window) pair and
 * produce the validated `WeeklyDigestPayload` that gets persisted
 * in the JSONB column and read by the FCM template.
 *
 * The aggregation itself is delegated to the
 * `IScansSourcePort` adapter so this service stays trivial and
 * easy to unit-test against any future analytics source.
 *
 * The Zod parse at the bottom is the one source of truth for the
 * payload contract — schema drift between the table column type,
 * the DTO, and the FCM template is caught here.
 */
@Injectable()
export class DigestPayloadBuilderService {
  constructor(
    @Inject(SCANS_SOURCE_TOKEN)
    private readonly scansSource: IScansSourcePort,
  ) {}

  /**
   * Compute the half-open week window in UTC and ask the adapter
   * for stats. The half-open convention `[start, end)` matches
   * how time-series queries are typically expressed and avoids
   * the off-by-one ambiguity at midnight.
   */
  async build(
    userId: string,
    weekStartingUtc: Date,
  ): Promise<WeeklyDigestPayload> {
    const weekEndingUtc = new Date(weekStartingUtc.getTime() + 7 * 24 * 60 * 60 * 1000);
    const stats = await this.scansSource.getWeeklyStats(
      userId,
      weekStartingUtc,
      weekEndingUtc,
    );

    return weeklyDigestPayloadSchema.parse({
      scansCount: stats.scansCount,
      highSugarCount: stats.highSugarCount,
      recallCount: stats.recallCount,
      alternativesRecommended: stats.alternativesRecommended,
      topProducts: stats.topProducts ?? [],
      savings: stats.savings ?? 0,
    });
  }
}
