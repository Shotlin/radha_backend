// BE-58 — Batch-date consensus computation.
//
// Pure functions, zero DB/Nest dependency, unit-tested in isolation with
// synthetic observation arrays (see __tests__/consensus.spec.ts) — the
// same discipline as the app's frame_consensus_aggregator.dart: the
// consensus RULES live here, completely decoupled from how observations
// get persisted or read.

export type BatchDateSource =
  | 'user_scan'
  | 'manual'
  | 'backfill_scan_items'
  | 'backfill_expiry_records';

export type ConsensusStatus = 'candidate' | 'trusted' | 'disputed';

export interface BatchDateObservationInput {
  userId: string;
  expiryDate: Date;
  mfgDate: Date | null;
  source: BatchDateSource;
  /** 0..1, null when the source is manual entry (no OCR confidence applies). */
  extractorConfidence: number | null;
}

export interface ConsensusSuggestion {
  expiryDate: Date;
  mfgDate: Date | null;
  distinctUsers: number;
}

export interface ConsensusResult {
  status: ConsensusStatus;
  consensusExpiry: Date | null;
  consensusMfg: Date | null;
  /** Total observations in the winning cluster (may exceed distinctUsers
   * if a user has voted for the same expiry more than once — the dedupe
   * unique index prevents literal duplicates, but a user CAN vote the
   * same (ean,batch) with two different expiry readings over time, and
   * both land in the same ±1-day cluster). */
  confirmations: number;
  distinctUsers: number;
  confidence: number;
  /** Populated only when `status === 'disputed'`. */
  suggestions: ConsensusSuggestion[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TRUST_MIN_DISTINCT_USERS = 3;
const TRUST_CONFIDENCE_FLOOR = 0.5;
const SINGLE_OBSERVATION_CONFIDENCE_GATE = 0.9;
const DISPUTED_MIN_DISTINCT_USERS_PER_CLUSTER = 2;
const DISPUTED_MIN_GAP_DAYS = 2;

/** Uppercase alphanumerics only — applied at every read/write boundary
 * so `"B.No: L-2043/A"` and `"l 2043 a"` are the same batch. */
export function normalizeBatchCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

interface _Cluster {
  observations: BatchDateObservationInput[];
}

function _daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / MS_PER_DAY;
}

/** Chain-clusters observations by expiry date: sorted ascending, a new
 * cluster starts whenever the gap to the immediately preceding
 * observation exceeds the ±1-day tolerance. This is the standard
 * "consecutive-gap" reading of a distance-tolerance clustering rule and
 * mirrors the same chain-clustering approach used by the app's fuzzy
 * vote clustering (frame_consensus_aggregator.dart). */
function _clusterByExpiry(observations: BatchDateObservationInput[]): _Cluster[] {
  const sorted = [...observations].sort(
    (a, b) => a.expiryDate.getTime() - b.expiryDate.getTime(),
  );
  const clusters: _Cluster[] = [];
  for (const obs of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && _daysBetween(last.observations[last.observations.length - 1].expiryDate, obs.expiryDate) <= 1) {
      last.observations.push(obs);
    } else {
      clusters.push({ observations: [obs] });
    }
  }
  return clusters;
}

function _distinctUserCount(observations: BatchDateObservationInput[]): number {
  return new Set(observations.map((o) => o.userId)).size;
}

function _hasNonBackfillObservation(observations: BatchDateObservationInput[]): boolean {
  return observations.some((o) => o.source === 'user_scan' || o.source === 'manual');
}

/** Modal (most frequent) value in `values`; ties break toward the
 * earliest-occurring value in the input order for determinism. */
function _modalDate(values: Date[]): Date | null {
  if (values.length === 0) return null;
  const counts = new Map<number, { date: Date; count: number }>();
  for (const v of values) {
    const key = v.getTime();
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { date: v, count: 1 });
  }
  let best: { date: Date; count: number } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.date ?? null;
}

function _clusterExpirySummary(cluster: _Cluster): { expiry: Date; mfg: Date | null } {
  const expiry = _modalDate(cluster.observations.map((o) => o.expiryDate))!;
  const mfgValues = cluster.observations
    .map((o) => o.mfgDate)
    .filter((d): d is Date => d !== null);
  return { expiry, mfg: _modalDate(mfgValues) };
}

/**
 * Computes the consensus for one (ean, batch) pair from its full set of
 * observations. Callers (the repository, inside the write transaction)
 * pass every observation for the pair, including the one just inserted —
 * this function is stateless and always recomputes from scratch rather
 * than incrementally updating a running total, trading a little CPU for
 * being trivially correct and trivially testable.
 */
export function computeConsensus(observations: BatchDateObservationInput[]): ConsensusResult {
  if (observations.length === 0) {
    throw new Error('computeConsensus requires at least one observation');
  }

  const clusters = _clusterByExpiry(observations)
    .map((c) => ({ cluster: c, distinctUsers: _distinctUserCount(c.observations) }))
    .sort((a, b) => {
      if (b.distinctUsers !== a.distinctUsers) return b.distinctUsers - a.distinctUsers;
      return b.cluster.observations.length - a.cluster.observations.length;
    });

  const totalDistinctUsers = _distinctUserCount(observations);
  const top = clusters[0];
  const second = clusters[1];

  // Disputed: two independently-credible clusters that disagree.
  if (
    second &&
    top.distinctUsers >= DISPUTED_MIN_DISTINCT_USERS_PER_CLUSTER &&
    second.distinctUsers >= DISPUTED_MIN_DISTINCT_USERS_PER_CLUSTER
  ) {
    const topSummary = _clusterExpirySummary(top.cluster);
    const secondSummary = _clusterExpirySummary(second.cluster);
    if (_daysBetween(topSummary.expiry, secondSummary.expiry) > DISPUTED_MIN_GAP_DAYS) {
      return {
        status: 'disputed',
        consensusExpiry: null,
        consensusMfg: null,
        confirmations: top.cluster.observations.length + second.cluster.observations.length,
        distinctUsers: top.distinctUsers + second.distinctUsers,
        confidence: 0,
        suggestions: [
          { expiryDate: topSummary.expiry, mfgDate: topSummary.mfg, distinctUsers: top.distinctUsers },
          { expiryDate: secondSummary.expiry, mfgDate: secondSummary.mfg, distinctUsers: second.distinctUsers },
        ],
      };
    }
  }

  const summary = _clusterExpirySummary(top.cluster);
  const winnerHasRealSource = _hasNonBackfillObservation(top.cluster.observations);

  if (top.distinctUsers >= TRUST_MIN_DISTINCT_USERS && winnerHasRealSource) {
    const confidence = Math.max(
      TRUST_CONFIDENCE_FLOOR,
      top.distinctUsers / totalDistinctUsers,
    );
    return {
      status: 'trusted',
      consensusExpiry: summary.expiry,
      consensusMfg: summary.mfg,
      confirmations: top.cluster.observations.length,
      distinctUsers: top.distinctUsers,
      confidence,
      suggestions: [],
    };
  }

  // Candidate tier: 1-2 distinct users, OR a >=3-distinct-user cluster
  // that's backfill-only (backfill can never produce `trusted` alone).
  if (top.cluster.observations.length === 1) {
    const only = top.cluster.observations[0];
    const qualifies =
      only.source === 'manual' ||
      (only.extractorConfidence ?? 0) >= SINGLE_OBSERVATION_CONFIDENCE_GATE;
    // A lone observation that doesn't clear the confidence/manual bar is
    // still the best information we have -- there's no 4th "insufficient
    // data" status in the API contract -- but its own (sub-gate)
    // confidence is reported honestly rather than a ratio that would
    // read as "100% confident" for a single weak OCR guess.
    return {
      status: 'candidate',
      consensusExpiry: summary.expiry,
      consensusMfg: summary.mfg,
      confirmations: 1,
      distinctUsers: 1,
      confidence: qualifies ? (only.extractorConfidence ?? 0.75) : (only.extractorConfidence ?? 0.3),
      suggestions: [],
    };
  }

  const confidence = top.distinctUsers / totalDistinctUsers;
  return {
    status: 'candidate',
    consensusExpiry: summary.expiry,
    consensusMfg: summary.mfg,
    confirmations: top.cluster.observations.length,
    distinctUsers: top.distinctUsers,
    confidence,
    suggestions: [],
  };
}
