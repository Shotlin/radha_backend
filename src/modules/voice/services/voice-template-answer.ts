import { randomUUID } from 'node:crypto';

import { BusinessSnapshot } from '../types/voice.types';
import { clampSpoken } from '../utils/voice-text.utils';
import type { VoiceTurnRequestDto } from '../dto/voice-assistant.dto';
import type { VoiceTurnResult } from '../types/voice.types';

/**
 * Deterministic fallback answer built directly from the already-fetched
 * [[BusinessSnapshot]] — no LLM call. Used whenever the LLM is
 * unconfigured, breaker-open, times out, or returns unparseable JSON.
 *
 * This is the entire reason architecture option (B) (pre-fetch the
 * snapshot, one LLM call) was chosen over a tool-calling loop: the real
 * data is already in hand before the LLM is ever invoked, so "the LLM is
 * down" degrades to a still-truthful templated answer instead of no
 * answer at all. Every number here is real; nothing is guessed.
 */
export function buildVoiceTemplateAnswer(
  snapshot: BusinessSnapshot,
  dto: VoiceTurnRequestDto,
): VoiceTurnResult {
  const parts: string[] = [];

  if (dto.intent === 'daily_summary') {
    if (snapshot.expiryStats) {
      parts.push(
        `${snapshot.expiryStats.expired} items expired and ${snapshot.expiryStats.red} are expiring soon.`,
      );
    }
    if (snapshot.taskStats) {
      const overdue = snapshot.taskStats.byStatus.overdue ?? 0;
      const pending = snapshot.taskStats.byStatus.pending ?? 0;
      parts.push(`${pending} tasks are pending${overdue > 0 ? `, ${overdue} overdue` : ''}.`);
    }
  } else {
    if (snapshot.expiryStats) {
      parts.push(
        `${snapshot.expiryStats.expired} expired, ${snapshot.expiryStats.red} expiring within a few days.`,
      );
    }
    if (snapshot.taskStats) {
      parts.push(
        `${snapshot.taskStats.byStatus.pending ?? 0} pending tasks, ` +
          `${snapshot.taskStats.byStatus.overdue ?? 0} overdue.`,
      );
    }
    if (snapshot.inventorySummary) {
      parts.push(`${snapshot.inventorySummary.lowStockCount} items are low on stock.`);
    }
  }

  const spokenText =
    parts.length > 0
      ? parts.join(' ')
      : "I can't reach the assistant right now, and I don't have enough data to answer that.";

  return {
    turnId: randomUUID(),
    spokenText: clampSpoken(spokenText),
    action: { kind: 'none' },
    source: 'template',
    degraded: true,
  };
}
