import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { DbService } from '@/db/db.service';
import type { BatchDateObservationRow, ProductBatchConsensusRow } from '@/db/schema/batch-dates';
import { LoggerService } from '@/logging/logger.service';

import {
  BatchDateObservationInput,
  ConsensusResult,
  computeConsensus,
  normalizeBatchCode,
} from '../consensus';
import { CreateObservationDto } from '../dto/batch-dates.dto';
import { BatchDatesRepository } from '../repositories/batch-dates.repository';

/** Spec §B2: "POST 20/day per user" — a daily submission cap mirroring
 * barcode-learning's own DB-counted pattern (services/barcode-learning.service.ts). */
export const MAX_OBSERVATIONS_PER_DAY = 20;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface BatchSummary {
  batchCode: string;
  status: string;
  expiryDate: Date | null;
  confirmations: number;
}

export interface BatchDatesResponse {
  ean: string;
  batchCode: string;
  expiryDate: Date | null;
  mfgDate: Date | null;
  status: string;
  confidence: number;
  confirmations: number;
  distinctUsers: number;
  suggestions: ConsensusResult['suggestions'];
}

@Injectable()
export class BatchDatesService {
  constructor(
    private readonly repo: BatchDatesRepository,
    private readonly db: DbService,
    private readonly logger: LoggerService,
  ) {}

  async listBatchesForProduct(ean: string): Promise<BatchSummary[]> {
    const rows = await this.repo.listConsensusForEan(ean);
    return rows.map((r) => this._toSummary(r));
  }

  async getBatchDates(ean: string, batchCodeRaw: string): Promise<BatchDatesResponse> {
    const batchCode = normalizeBatchCode(batchCodeRaw);
    const consensus = await this.repo.findConsensus(ean, batchCode);
    if (!consensus) {
      throw new NotFoundException(`No observations for EAN ${ean} batch ${batchCode}`);
    }

    // The consensus table only persists the winning cluster's dates
    // (null for disputed) -- `suggestions` is derived, not stored, so a
    // disputed read recomputes from the raw observations. Every other
    // status returns straight from the precomputed row (spec's intended
    // fast path: GET never computes on the fly except this one
    // deliberately-rare case).
    let suggestions: ConsensusResult['suggestions'] = [];
    if (consensus.status === 'disputed') {
      const observations = await this.repo.listObservations(ean, batchCode);
      suggestions = computeConsensus(this._toConsensusInputs(observations)).suggestions;
    }

    return {
      ean,
      batchCode,
      expiryDate: consensus.consensusExpiry,
      mfgDate: consensus.consensusMfg,
      status: consensus.status,
      confidence: Number(consensus.confidence),
      confirmations: consensus.confirmations,
      distinctUsers: consensus.distinctUsers,
      suggestions,
    };
  }

  async submitObservation(
    userId: string,
    ean: string,
    batchCodeRaw: string,
    dto: CreateObservationDto,
  ): Promise<BatchDatesResponse> {
    const batchCode = normalizeBatchCode(batchCodeRaw);

    const since = new Date(Date.now() - ONE_DAY_MS);
    const todayCount = await this.repo.countObservationsByUserSince(userId, since);
    if (todayCount >= MAX_OBSERVATIONS_PER_DAY) {
      throw new ConflictException(
        `Daily observation limit reached (max ${MAX_OBSERVATIONS_PER_DAY} per user per day)`,
      );
    }

    await this.db.transaction(async (tx) => {
      await this.repo.insertObservation(
        {
          ean,
          batchCode,
          mfgDate: dto.mfgDate ?? null,
          expiryDate: dto.expiryDate,
          userId,
          source: dto.capturedVia === 'manual' ? 'manual' : 'user_scan',
          extractorConfidence:
            dto.extractorConfidence !== undefined ? String(dto.extractorConfidence) : null,
        },
        tx,
      );
      // Idempotent even on the "no-op" (already-voted) path -- recompute
      // and upsert unconditionally inside the same transaction so the
      // response is always the CURRENT consensus, matching spec's
      // "response returns the current consensus either way."
      const observations = await this.repo.listObservations(ean, batchCode, tx);
      const result = computeConsensus(this._toConsensusInputs(observations));
      await this.repo.upsertConsensus(
        {
          ean,
          batchCode,
          consensusExpiry: result.consensusExpiry,
          consensusMfg: result.consensusMfg,
          confirmations: result.confirmations,
          distinctUsers: result.distinctUsers,
          confidence: String(result.confidence),
          status: result.status,
        },
        tx,
      );
    });

    this.logger.info('batch_dates.observation_submitted', { userId, ean, batchCode });

    return this.getBatchDates(ean, batchCode);
  }

  private _toConsensusInputs(rows: BatchDateObservationRow[]): BatchDateObservationInput[] {
    return rows.map((r) => ({
      userId: r.userId,
      expiryDate: r.expiryDate,
      mfgDate: r.mfgDate,
      source: r.source,
      extractorConfidence: r.extractorConfidence !== null ? Number(r.extractorConfidence) : null,
    }));
  }

  private _toSummary(row: ProductBatchConsensusRow): BatchSummary {
    return {
      batchCode: row.batchCode,
      status: row.status,
      expiryDate: row.consensusExpiry,
      confirmations: row.confirmations,
    };
  }
}
