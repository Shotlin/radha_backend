/**
 * BE-35 — Touchpoints response interface.
 *
 * Returned by GET /api/v1/account/touchpoints. Each boolean flag
 * indicates whether a specific activation touchpoint should be
 * displayed to the current Consumer user.
 *
 * Note: `day7Push` is an internal-only touchpoint handled by the
 * cron job (Day7PushJob) and is NOT exposed in this response.
 */
export interface TouchpointsResponseDto {
  /** True if user has 5+ lifetime scans → show smart banner */
  banner5Scans: boolean;
  /** Always true for Consumer without a business tenant → home card */
  homeCard: boolean;
  /** True if user has 50+ scans this week → heavy-scan trigger */
  heavyScanWeekly: boolean;
  /** Always true for Consumer → profile screen CTA */
  profileCta: boolean;
  /** True when saved products >= 5 → about to hit save limit */
  saveLimitPrompt: boolean;
}

/**
 * Internal-only touchpoint eligibility that includes the day-7 push
 * flag. Used by the cron job for evaluation but never sent to client.
 */
export interface InternalTouchpointEligibility extends TouchpointsResponseDto {
  /** True if user was registered 7+ days ago without activating business */
  day7Push: boolean;
  /** From BE-34 onboarding segment — true if user selected a business segment */
  onboardingCard: boolean;
}
