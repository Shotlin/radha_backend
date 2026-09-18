import type { ExpiryRecordWithProductName } from '@/modules/expiry/expiry.service';
import type { ExpiryStats } from '@/modules/expiry/types/expiry.types';
import type { InventorySummary } from '@/modules/inventory/types/inventory.types';
import type { TaskStats } from '@/modules/tasks/types/task.types';

/**
 * Snapshot of a store's live business data, assembled in-process (no HTTP
 * self-calls) from the same services the app's own screens already use.
 * Each field is independently nullable — one dead subsystem degrades a
 * line of the answer, never the whole turn (see BusinessSnapshotService).
 */
export interface BusinessSnapshot {
  storeId: string;
  generatedAt: Date;
  expiryStats: ExpiryStats | null;
  /** Up to 8 rows, next 7 days, ordered by expiry date — for naming products aloud. */
  nearExpiry: ExpiryRecordWithProductName[];
  taskStats: TaskStats | null;
  inventorySummary: InventorySummary | null;
}

export type VoiceActionKind = 'none' | 'clarify' | 'navigate' | 'prepare_task';

/**
 * The full union is modelled from Phase 1 even though only `none`/`clarify`
 * are ever produced today — `route`/`params`/`task` are reserved for
 * Phase 2 (navigation) and Phase 3 (task drafts) so the response contract
 * (and the Dart DTO mirroring it) never has to change shape later.
 */
export interface VoiceAction {
  kind: VoiceActionKind;
  route?: string;
  params?: Record<string, string>;
}

export interface VoiceTurnResult {
  turnId: string;
  /** Read aloud verbatim — always ≤ SPOKEN_MAX_CHARS, see clampSpoken(). */
  spokenText: string;
  /** Optional longer text for the reply card. Never spoken. */
  displayText?: string;
  action: VoiceAction;
  /** Whether this came from the LLM or the deterministic snapshot template. */
  source: 'llm' | 'template';
  /** True whenever `source === 'template'` — the LLM was unavailable/failed. */
  degraded: boolean;
}
