import { Injectable } from '@nestjs/common';

import type {
  AgeBand,
  AgeBandSafety,
  ChildSafetyResult,
  ChildSafetyStatus,
  ScoringInput,
} from '../types/health.types';

/**
 * BE-12 — Child Safety classification.
 *
 * Status is downgraded conservatively (never upgraded). Each rule
 * either keeps `suitable` or pushes to `caution` / `unsuitable`.
 *
 * Age-band safety (Req 4) is computed from the same signals but with
 * stricter thresholds for younger children (infants and toddlers).
 *
 * The thresholds intentionally match the v1 rule set so the engine
 * and the child-safety classifier never disagree on a single product.
 */

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const has = (v: unknown): boolean => v !== null && v !== undefined && Number.isFinite(Number(v));

@Injectable()
export class ChildSafetyService {
  evaluateForChildren(input: ScoringInput): ChildSafetyResult {
    if (!input.nutrition) {
      return {
        status: 'unknown',
        reasons: ['Nutrition data unavailable'],
      };
    }

    const reasons: string[] = [];
    let status: ChildSafetyStatus = 'suitable';

    const downgradeTo = (next: 'caution' | 'unsuitable'): void => {
      if (next === 'unsuitable') status = 'unsuitable';
      else if (status === 'suitable') status = 'caution';
    };

    const sugars = num(input.nutrition.sugars);
    if (sugars > 22.5) {
      downgradeTo('unsuitable');
      reasons.push(`Very high sugar (${sugars.toFixed(1)} g/100g)`);
    } else if (sugars > 10) {
      downgradeTo('caution');
      reasons.push(`High sugar (${sugars.toFixed(1)} g/100g)`);
    }

    const fat = num(input.nutrition.fat);
    if (fat > 17.5) {
      downgradeTo('unsuitable');
      reasons.push(`Very high fat (${fat.toFixed(1)} g/100g)`);
    } else if (fat > 15) {
      downgradeTo('caution');
      reasons.push(`High fat (${fat.toFixed(1)} g/100g)`);
    }

    const transFat = num(input.nutrition.transFat);
    if (has(input.nutrition.transFat) && transFat > 0) {
      downgradeTo('unsuitable');
      reasons.push('Contains trans fat');
    }

    if (input.nutrition.isProcessed === 'ultra') {
      downgradeTo('caution');
      reasons.push('Ultra-processed food');
    }

    const sodium = num(input.nutrition.sodium);
    if (sodium > 600) {
      downgradeTo('caution');
      reasons.push(`High sodium (${sodium.toFixed(0)} mg/100g)`);
    }

    return {
      status,
      reasons,
      ageRecommendation: this.suggestAgeBand(status),
    };
  }

  /**
   * Age-band classification (BE-12 v2 ADDENDUM Req 4).
   *
   * Stricter for infants/toddlers — even a `suitable` v1 verdict can
   * still be infant-unsafe if there's any added sugar or sodium.
   */
  classifyAgeBands(input: ScoringInput): AgeBandSafety {
    if (!input.nutrition) {
      return {
        infantSafe: false,
        toddlerSafe: false,
        childSafe: false,
        adolescentSafe: false,
        rationale: 'Nutrition data unavailable',
      };
    }

    const sugars = num(input.nutrition.sugars);
    const fat = num(input.nutrition.fat);
    const sat = num(input.nutrition.saturatedFat);
    const transFat = num(input.nutrition.transFat);
    const sodium = num(input.nutrition.sodium);
    const ultra = input.nutrition.isProcessed === 'ultra';

    // Hard fail: trans fat is not safe for any age.
    if (has(input.nutrition.transFat) && transFat > 0) {
      return {
        infantSafe: false,
        toddlerSafe: false,
        childSafe: false,
        adolescentSafe: false,
        rationale: 'Contains trans fat — unsuitable for all ages',
      };
    }

    // Infant 0-2 yr — WHO: avoid added sugars, avoid added salt, avoid ultra-processed.
    const infantSafe = sugars <= 2 && sodium <= 50 && !ultra && fat <= 25;

    // Toddler 2-5 yr — limit sugars / sodium / saturated fat.
    const toddlerSafe = sugars <= 5 && sodium <= 200 && sat <= 3 && !ultra;

    // Child 5-12 yr — broadly aligned with v1 child-safety status.
    const childSafe = sugars <= 10 && sodium <= 360 && sat <= 5 && fat <= 15;

    // Adolescent 12-18 yr — same as adult unless extreme.
    const adolescentSafe = sugars <= 22.5 && sodium <= 600 && fat <= 17.5;

    return {
      infantSafe,
      toddlerSafe,
      childSafe,
      adolescentSafe,
      rationale: this.rationaleFor({
        sugars,
        fat,
        sodium,
        sat,
        ultra,
      }),
    };
  }

  evaluateForAge(
    input: ScoringInput,
    age: AgeBand,
  ): { status: ChildSafetyStatus; reasons: string[] } {
    const bands = this.classifyAgeBands(input);
    const safe = ((): boolean => {
      switch (age) {
        case 'infant':
          return bands.infantSafe;
        case 'toddler':
          return bands.toddlerSafe;
        case 'child':
          return bands.childSafe;
        case 'adolescent':
          return bands.adolescentSafe;
        case 'adult':
          return true;
        default:
          return bands.adolescentSafe;
      }
    })();
    return {
      status: safe ? 'suitable' : 'unsuitable',
      reasons: [bands.rationale],
    };
  }

  private suggestAgeBand(status: ChildSafetyStatus): AgeBand | undefined {
    if (status === 'unsuitable' || status === 'unknown') return undefined;
    if (status === 'caution') return 'adolescent';
    return 'child';
  }

  private rationaleFor(s: {
    sugars: number;
    fat: number;
    sodium: number;
    sat: number;
    ultra: boolean;
  }): string {
    const parts: string[] = [];
    if (s.sugars > 10) parts.push(`sugar ${s.sugars.toFixed(1)} g`);
    if (s.fat > 15) parts.push(`fat ${s.fat.toFixed(1)} g`);
    if (s.sat > 5) parts.push(`saturated ${s.sat.toFixed(1)} g`);
    if (s.sodium > 360) parts.push(`sodium ${s.sodium.toFixed(0)} mg`);
    if (s.ultra) parts.push('ultra-processed');
    return parts.length === 0 ? 'Within healthy limits per 100g' : `Elevated: ${parts.join(', ')}`;
  }
}
