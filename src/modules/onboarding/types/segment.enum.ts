/**
 * BE-34 — Onboarding segment enum.
 *
 * Represents the six self-selection choices shown on the 2x3 tap-card grid
 * during onboarding (Req 26).
 */
export const ONBOARDING_SEGMENTS = [
  'personal',
  'business_owner',
  'parent',
  'pharmacy',
  'institution',
  'auditor_invited',
] as const;

export type OnboardingSegment = (typeof ONBOARDING_SEGMENTS)[number];

/**
 * Possible next-screen routing targets returned after segment selection.
 */
export type OnboardingNextScreen =
  | 'consumer_home'
  | 'consumer_home_with_allergen_setup'
  | 'business_activation_flow'
  | 'auditor_invitation_token_entry';

/**
 * Business-activation presets for the three B2B segments.
 */
export type BusinessActivationPreset = 'business_owner' | 'pharmacy' | 'institution';
