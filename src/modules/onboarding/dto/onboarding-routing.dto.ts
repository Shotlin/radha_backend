import type {
  BusinessActivationPreset,
  OnboardingNextScreen,
  OnboardingSegment,
} from '../types/segment.enum';

/**
 * BE-34 — Response DTO from POST /api/v1/onboarding/segment.
 *
 * Tells the client which screen to navigate to after onboarding.
 */
export interface OnboardingRoutingDto {
  nextScreen: OnboardingNextScreen;
  segment: OnboardingSegment;
  presetForBusinessActivation?: BusinessActivationPreset;
  bypassedOnboarding: boolean;
}
