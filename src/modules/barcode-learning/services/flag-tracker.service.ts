import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { FlagRepository } from '../repositories/flag.repository';
import { SubmissionRepository } from '../repositories/submission.repository';

/**
 * BE-56 — Flag accumulation + re-moderation flip.
 *
 * Per the BE-56 spec ("Re-moderation rule: when a product accumulates
 * 3 unique flags, status flips back to `pending` and re-enters the
 * moderator queue") this tiny service owns one decision: after a
 * flag is recorded, has the threshold been crossed, and if so flip
 * the most recent approved submission for that EAN back into the
 * queue.
 *
 * We use status `flagged` (not `pending`) so the moderator UI can
 * filter / surface re-reviewed entries differently from never-seen
 * submissions; the queue endpoint accepts both as "needs review".
 *
 * The threshold itself is exported so callers (tests, future tuning)
 * can reference the same constant. Bumping it does not require a
 * migration — flags below the new threshold simply stop triggering.
 */
export const FLAG_REMODERATION_THRESHOLD = 3;

export interface FlagTrackResult {
  ean: string;
  uniqueFlagCount: number;
  thresholdCrossed: boolean;
  /**
   * Set when `thresholdCrossed` is `true` AND we found an approved
   * submission to flip. `null` when no approved submission exists
   * yet for the EAN (i.e. the flags target an OFF row that the
   * community service never owned).
   */
  flippedSubmissionId: string | null;
}

@Injectable()
export class FlagTrackerService {
  constructor(
    private readonly flags: FlagRepository,
    private readonly submissions: SubmissionRepository,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Inspect the current flag count for `ean` and, if the threshold
   * has been crossed, flip the most recent approved submission back
   * into the moderator queue with `status = 'flagged'`. Idempotent —
   * re-running with the same EAN after the flip is a no-op because
   * the submission is no longer in the `approved` state.
   */
  async evaluate(ean: string): Promise<FlagTrackResult> {
    const uniqueFlagCount = await this.flags.countUniqueByEan(ean);
    const thresholdCrossed = uniqueFlagCount >= FLAG_REMODERATION_THRESHOLD;

    if (!thresholdCrossed) {
      return { ean, uniqueFlagCount, thresholdCrossed, flippedSubmissionId: null };
    }

    const approved = await this.submissions.findLatestApprovedByEan(ean);
    if (!approved) {
      // Three flags but no community-approved row to flip. Log it
      // (this is a useful signal: people are flagging an OFF entry
      // we don't own) and stop.
      this.logger.warn('barcode_learning.flag_threshold.no_approved_submission', {
        ean,
        uniqueFlagCount,
      });
      return { ean, uniqueFlagCount, thresholdCrossed, flippedSubmissionId: null };
    }

    await this.submissions.updateStatus(approved.id, {
      status: 'flagged',
      moderationNotes: `re-moderation: ${uniqueFlagCount} unique flags on EAN ${ean}`,
    });

    this.logger.info('barcode_learning.flag_threshold.crossed', {
      ean,
      uniqueFlagCount,
      submissionId: approved.id,
    });

    void this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'barcode_learning_submission',
      resourceId: approved.id,
      tenantId: '',
      userId: 'system',
      success: true,
      metadata: {
        reason: 'flag_threshold_crossed',
        ean,
        uniqueFlagCount,
        threshold: FLAG_REMODERATION_THRESHOLD,
      },
    });

    return { ean, uniqueFlagCount, thresholdCrossed, flippedSubmissionId: approved.id };
  }
}
