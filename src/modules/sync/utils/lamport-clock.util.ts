/**
 * BE-44 — Lamport-style logical clock comparator.
 *
 * Mobile_App tags every offline-queued mutation with a Lamport
 * timestamp `(counter, nodeId)`. Server uses these to resolve
 * last-write-wins conflicts when the same record is mutated
 * concurrently from multiple devices.
 *
 * Compare semantics:
 *   - Higher `counter` wins.
 *   - Tie-break on `nodeId` lexicographic order so the result is
 *     deterministic across hosts.
 *
 * The wire format is simple — clients send `{ counter, nodeId }` or a
 * single number for legacy (pre-Lamport) builds. `parseLamport` accepts
 * both shapes and never throws on malformed input; it returns `null`
 * which `compare` treats as "lower than anything".
 */

export interface LamportTimestamp {
  counter: number;
  nodeId: string;
}

/** Wire shapes accepted from clients. */
export type LamportInput =
  | LamportTimestamp
  | { counter: number; nodeId?: string }
  | number
  | string
  | null
  | undefined;

/**
 * Normalise a value coming off the wire into a `LamportTimestamp` or
 * `null` if it's unusable. Never throws.
 */
export function parseLamport(input: LamportInput): LamportTimestamp | null {
  if (input == null) return null;

  if (typeof input === 'number' && Number.isFinite(input)) {
    return { counter: Math.max(0, Math.floor(input)), nodeId: '' };
  }

  if (typeof input === 'string') {
    // Accept either pure numeric ("12345") or "counter:nodeId".
    const sep = input.indexOf(':');
    if (sep >= 0) {
      const counter = Number.parseInt(input.slice(0, sep), 10);
      const nodeId = input.slice(sep + 1);
      if (Number.isFinite(counter) && counter >= 0) {
        return { counter, nodeId };
      }
      return null;
    }
    const counter = Number.parseInt(input, 10);
    if (Number.isFinite(counter) && counter >= 0) {
      return { counter, nodeId: '' };
    }
    return null;
  }

  if (typeof input === 'object' && 'counter' in input) {
    const counter = Number((input as { counter: unknown }).counter);
    if (!Number.isFinite(counter) || counter < 0) return null;
    const nodeId = typeof (input as { nodeId?: unknown }).nodeId === 'string'
      ? (input as { nodeId: string }).nodeId
      : '';
    return { counter: Math.floor(counter), nodeId };
  }

  return null;
}

/**
 * Compare two Lamport timestamps. Returns:
 *   -1 if `a` is older (i.e. `b` wins),
 *    0 if equal,
 *    1 if `a` is newer.
 *
 * `null` is treated as the smallest possible value, so any real
 * timestamp wins over a missing one.
 */
export function compareLamport(
  a: LamportTimestamp | null,
  b: LamportTimestamp | null,
): -1 | 0 | 1 {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;

  if (a.counter < b.counter) return -1;
  if (a.counter > b.counter) return 1;

  // Equal counters — break the tie on `nodeId` so the result is
  // deterministic across hosts. Empty nodeIds compare lexicographically
  // before any non-empty id.
  if (a.nodeId < b.nodeId) return -1;
  if (a.nodeId > b.nodeId) return 1;
  return 0;
}

/** True when `incoming` should replace `current` under last-write-wins. */
export function lamportWins(
  incoming: LamportTimestamp | null,
  current: LamportTimestamp | null,
): boolean {
  return compareLamport(incoming, current) > 0;
}
