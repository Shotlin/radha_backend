/**
 * BE-46 — IST (Asia/Kolkata, UTC+05:30) time helpers.
 *
 * The free-tier daily quota resets at 00:00 IST regardless of where
 * the request originates. We deliberately avoid pulling in a heavy
 * timezone library (date-fns-tz / luxon) because the offset is fixed
 * and India does not observe DST — a 19800-second constant covers
 * every case.
 *
 * Exports:
 *   - `todayIST()`                    → `YYYY-MM-DD` in IST
 *   - `yearMonthIST()`                → `YYYY-MM` in IST
 *   - `secondsUntilMidnightIST()`     → integer seconds until the
 *                                       next IST midnight (used as
 *                                       the Redis EXPIRE TTL)
 *   - `secondsUntilMonthEndIST()`     → integer seconds until the
 *                                       first day of the next month
 *                                       at 00:00 IST
 *   - `midnightISTAsIso()`            → ISO-8601 timestamp of the
 *                                       next IST midnight (returned
 *                                       in 429 bodies as `resetAt`)
 *   - `monthEndISTAsIso()`            → ISO-8601 timestamp of the
 *                                       first day of next month at
 *                                       00:00 IST
 *
 * Every helper accepts an optional `now` parameter so tests can pin
 * the clock without monkey-patching `Date`.
 */

/** Asia/Kolkata is a fixed +05:30 offset year-round (no DST). */
export const IST_OFFSET_MINUTES = 5 * 60 + 30;
export const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

/** Convert a UTC instant to a "shifted" Date whose UTC components reflect IST wall-clock. */
function toIstShifted(now: Date): Date {
  return new Date(now.getTime() + IST_OFFSET_MS);
}

/** Pad a number to a fixed width with leading zeros. */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Returns the IST calendar date as `YYYY-MM-DD`. */
export function todayIST(now: Date = new Date()): string {
  const ist = toIstShifted(now);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

/** Returns the IST calendar year-month as `YYYY-MM`. */
export function yearMonthIST(now: Date = new Date()): string {
  const ist = toIstShifted(now);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}`;
}

/**
 * Returns the next IST midnight as a real UTC Date.
 * Used by both the seconds-until and the ISO-8601 helpers.
 */
function nextMidnightIstAsUtc(now: Date = new Date()): Date {
  const ist = toIstShifted(now);
  // Build "tomorrow at 00:00 IST" in the shifted space.
  const tomorrowIst = new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, 0, 0, 0, 0),
  );
  // Shift back to UTC by subtracting the IST offset.
  return new Date(tomorrowIst.getTime() - IST_OFFSET_MS);
}

/** Returns the first day of the next month at 00:00 IST as a real UTC Date. */
function nextMonthStartIstAsUtc(now: Date = new Date()): Date {
  const ist = toIstShifted(now);
  const nextMonthIst = new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  return new Date(nextMonthIst.getTime() - IST_OFFSET_MS);
}

/**
 * Integer seconds from `now` until the next IST midnight. The
 * value is always at least 1 so Redis EXPIRE never receives a
 * non-positive TTL.
 */
export function secondsUntilMidnightIST(now: Date = new Date()): number {
  const target = nextMidnightIstAsUtc(now);
  const diffMs = target.getTime() - now.getTime();
  return Math.max(1, Math.ceil(diffMs / 1000));
}

/** Integer seconds from `now` until the first day of next month at 00:00 IST. */
export function secondsUntilMonthEndIST(now: Date = new Date()): number {
  const target = nextMonthStartIstAsUtc(now);
  const diffMs = target.getTime() - now.getTime();
  return Math.max(1, Math.ceil(diffMs / 1000));
}

/** ISO-8601 string for the next IST midnight (UTC representation). */
export function midnightISTAsIso(now: Date = new Date()): string {
  return nextMidnightIstAsUtc(now).toISOString();
}

/** ISO-8601 string for the first day of next month at 00:00 IST (UTC representation). */
export function monthEndISTAsIso(now: Date = new Date()): string {
  return nextMonthStartIstAsUtc(now).toISOString();
}
