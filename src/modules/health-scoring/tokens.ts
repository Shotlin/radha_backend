import type { IAllergenProfileService } from './types/health.types';

/**
 * BE-12 ↔ BE-37 dependency-inversion port.
 *
 * BE-12 must NOT import from `modules/allergen-profiles` (which lands
 * in BE-37) — that would create a forward dependency. Instead BE-12
 * declares this token, and BE-37's module provides the concrete
 * implementation. Until BE-37 ships, the HealthScoringModule binds a
 * no-op default (returns null), so the comprehensive scan endpoint
 * still works — it just never produces profile matches.
 */
export const ALLERGEN_PROFILE_SERVICE = Symbol('ALLERGEN_PROFILE_SERVICE');

export type AllergenProfileServicePort = IAllergenProfileService;
