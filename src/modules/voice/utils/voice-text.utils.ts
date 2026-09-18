import { BusinessSnapshot } from '../types/voice.types';

/**
 * Hard ceiling on spoken text. The free Fish Audio TTS model
 * (`fish-audio/s2.1-pro-free:free`) timed out on ~1700 characters even at
 * a 25s budget (see `AI_TTS_TIMEOUT_MS` / `synthesizeSpeech` in
 * `llm.service.ts`) — this keeps every voice-assistant reply comfortably
 * inside what that model can actually finish synthesizing.
 */
export const SPOKEN_MAX_CHARS = 240;

/**
 * Truncates at the last sentence boundary at or before the limit, rather
 * than mid-word — enforced independently of the prompt instruction and the
 * `maxTokens` cap, so a reply is GUARANTEED short even if the model
 * ignores both.
 */
export function clampSpoken(text: string): string {
  const t = (text ?? '').trim();
  if (t.length <= SPOKEN_MAX_CHARS) return t;
  const truncated = t.slice(0, SPOKEN_MAX_CHARS);
  const lastStop = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('? '),
    truncated.lastIndexOf('! '),
  );
  // Only trust the sentence boundary if it isn't absurdly early (a false
  // match on a decimal number or abbreviation near the start) — otherwise
  // just hard-cut with an ellipsis.
  return lastStop > 40 ? truncated.slice(0, lastStop + 1) : `${truncated.trimEnd()}…`;
}

function daysUntil(date: Date, from: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.ceil((date.getTime() - from.getTime()) / msPerDay);
}

/**
 * Flattens a [[BusinessSnapshot]] into plain text for the LLM prompt.
 * Deliberately flat text, not JSON — cheaper in tokens for the same
 * information, and the model doesn't need to parse structure it's only
 * reading, not returning.
 */
export function renderSnapshotText(snapshot: BusinessSnapshot): string {
  const lines: string[] = [];
  const now = snapshot.generatedAt;
  lines.push(`TODAY: ${now.toISOString().slice(0, 10)}`);

  if (snapshot.expiryStats) {
    const s = snapshot.expiryStats;
    lines.push(
      `EXPIRY: ${s.total} tracked total, ${s.expired} already expired, ` +
        `${s.red} expiring within a few days (red), ${s.yellow} expiring soon (yellow).`,
    );
  } else {
    lines.push('EXPIRY: data unavailable right now.');
  }

  if (snapshot.nearExpiry.length > 0) {
    const items = snapshot.nearExpiry
      .map((r) => {
        const name = r.productName ?? 'an unnamed product';
        const days = daysUntil(new Date(r.expiryDate), now);
        const when = days <= 0 ? 'already expired' : days === 1 ? 'expires in 1 day' : `expires in ${days} days`;
        return `${name} (${r.remainingQuantity} units, ${when})`;
      })
      .join('; ');
    lines.push(`EXPIRING SOON: ${items}.`);
  }

  if (snapshot.taskStats) {
    const t = snapshot.taskStats;
    const pending = t.byStatus.pending ?? 0;
    const overdue = t.byStatus.overdue ?? 0;
    const inProgress = t.byStatus.in_progress ?? 0;
    const completed = t.byStatus.completed ?? 0;
    lines.push(
      `TASKS: ${pending} pending, ${inProgress} in progress, ${overdue} overdue, ` +
        `${completed} completed in total (not scoped to today).`,
    );
  } else {
    lines.push('TASKS: data unavailable right now.');
  }

  if (snapshot.inventorySummary) {
    const inv = snapshot.inventorySummary;
    lines.push(
      `INVENTORY: ${inv.totalProducts} products tracked, ${inv.lowStockCount} low on stock, ` +
        `${inv.expiringSoonCount} expiring soon, ${inv.expiredCount} expired.`,
    );
  } else {
    lines.push('INVENTORY: data unavailable right now.');
  }

  return lines.join('\n');
}
