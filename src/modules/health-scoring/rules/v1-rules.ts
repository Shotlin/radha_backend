import type { HealthRule, RuleResult, ScoringInput } from '../types/health.types';

/**
 * V1 health-scoring rule set.
 *
 * Thresholds are derived from:
 *   - WHO recommendations on free sugars / saturated fat / sodium,
 *   - FSSAI Indian guidelines (where they differ from WHO),
 *   - Nutri-Score (European standard) for grade banding,
 *   - Pediatric-nutrition guidance for child-safety.
 *
 * Rules MUST be **pure functions**. Same `ScoringInput` ⇒ same
 * `RuleResult` — the engine relies on this for caching.
 *
 * To add v2: copy this file to `v2-rules.ts`, bump
 * `RULE_VERSION_V2`, register it in `ScoringEngineService.ruleSets`.
 * Old assessments stay valid because `product_health_assessments`
 * stores `rule_version` per row.
 */
export const RULE_VERSION_V1 = '1.0.0';

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const noTrigger = (): RuleResult => ({ triggered: false, score: 0 });

/* ─────────────────── Sugar ─────────────────── */

const sugarHigh: HealthRule = {
  id: 'sugar-high',
  version: RULE_VERSION_V1,
  name: 'High Sugar Content',
  category: 'sugar',
  weight: 0.25,
  evaluator: (input: ScoringInput): RuleResult => {
    const sugars = num(input.nutrition?.sugars);
    if (sugars === undefined) return noTrigger();

    if (sugars > 22.5) {
      return {
        triggered: true,
        score: -25,
        warning: {
          type: 'high_sugar',
          severity: 'high',
          message: 'Very high sugar content',
          threshold: 22.5,
          actual: sugars,
          unit: 'g/100g',
        },
      };
    }
    if (sugars > 10) {
      return {
        triggered: true,
        score: -10,
        warning: {
          type: 'high_sugar',
          severity: 'medium',
          message: 'High sugar content',
          threshold: 10,
          actual: sugars,
          unit: 'g/100g',
        },
      };
    }
    return noTrigger();
  },
};

/* ─────────────────── Fat / oil ─────────────────── */

const fatHigh: HealthRule = {
  id: 'fat-high',
  version: RULE_VERSION_V1,
  name: 'High Fat Content',
  category: 'fat',
  weight: 0.2,
  evaluator: (input) => {
    const fat = num(input.nutrition?.fat);
    if (fat === undefined) return noTrigger();

    if (fat > 17.5) {
      return {
        triggered: true,
        score: -20,
        warning: {
          type: 'high_oil',
          severity: 'high',
          message: 'Very high fat content',
          threshold: 17.5,
          actual: fat,
          unit: 'g/100g',
        },
      };
    }
    if (fat > 15) {
      return {
        triggered: true,
        score: -10,
        warning: {
          type: 'high_oil',
          severity: 'medium',
          message: 'High fat content',
          threshold: 15,
          actual: fat,
          unit: 'g/100g',
        },
      };
    }
    return noTrigger();
  },
};

const saturatedFatHigh: HealthRule = {
  id: 'saturated-fat-high',
  version: RULE_VERSION_V1,
  name: 'High Saturated Fat',
  category: 'fat',
  weight: 0.15,
  evaluator: (input) => {
    const sat = num(input.nutrition?.saturatedFat);
    if (sat === undefined) return noTrigger();

    if (sat > 5) {
      return {
        triggered: true,
        score: -15,
        warning: {
          type: 'high_saturated_fat',
          severity: 'high',
          message: 'High saturated fat',
          threshold: 5,
          actual: sat,
          unit: 'g/100g',
        },
      };
    }
    if (sat > 1.5) {
      return {
        triggered: true,
        score: -5,
        warning: {
          type: 'high_saturated_fat',
          severity: 'medium',
          message: 'Moderate saturated fat',
          threshold: 1.5,
          actual: sat,
          unit: 'g/100g',
        },
      };
    }
    return noTrigger();
  },
};

const transFat: HealthRule = {
  id: 'trans-fat',
  version: RULE_VERSION_V1,
  name: 'Trans Fat Detected',
  category: 'fat',
  weight: 0.2,
  evaluator: (input) => {
    const tf = num(input.nutrition?.transFat);
    // Trans fat is a hard penalty regardless of magnitude.
    if (tf === undefined || tf <= 0) return noTrigger();
    return {
      triggered: true,
      score: -30,
      warning: {
        type: 'trans_fat',
        severity: 'high',
        message: 'Contains trans fat',
        threshold: 0,
        actual: tf,
        unit: 'g/100g',
      },
    };
  },
};

/* ─────────────────── Sodium ─────────────────── */

const sodiumHigh: HealthRule = {
  id: 'sodium-high',
  version: RULE_VERSION_V1,
  name: 'High Sodium',
  category: 'sodium',
  weight: 0.15,
  evaluator: (input) => {
    const sodium = num(input.nutrition?.sodium);
    if (sodium === undefined) return noTrigger();

    if (sodium > 600) {
      return {
        triggered: true,
        score: -15,
        warning: {
          type: 'high_sodium',
          severity: 'high',
          message: 'Very high sodium',
          threshold: 600,
          actual: sodium,
          unit: 'mg/100g',
        },
      };
    }
    if (sodium > 360) {
      return {
        triggered: true,
        score: -8,
        warning: {
          type: 'high_sodium',
          severity: 'medium',
          message: 'High sodium',
          threshold: 360,
          actual: sodium,
          unit: 'mg/100g',
        },
      };
    }
    return noTrigger();
  },
};

/* ─────────────────── Processing ─────────────────── */

const ultraProcessed: HealthRule = {
  id: 'ultra-processed',
  version: RULE_VERSION_V1,
  name: 'Ultra-Processed Food',
  category: 'processing',
  weight: 0.2,
  evaluator: (input) => {
    if (input.nutrition?.isProcessed === 'ultra') {
      return {
        triggered: true,
        score: -20,
        warning: {
          type: 'ultra_processed',
          severity: 'high',
          message: 'Ultra-processed food',
          threshold: 4,
          actual: 4,
          unit: 'NOVA group',
        },
      };
    }
    return noTrigger();
  },
};

/* ─────────────────── Positives ─────────────────── */

const highProtein: HealthRule = {
  id: 'high-protein',
  version: RULE_VERSION_V1,
  name: 'High Protein',
  category: 'positive',
  weight: 0.1,
  evaluator: (input) => {
    const protein = num(input.nutrition?.protein);
    if (protein === undefined || protein < 12) return noTrigger();
    return {
      triggered: true,
      score: 10,
      positive: { type: 'high_protein', message: 'Good source of protein' },
    };
  },
};

const highFiber: HealthRule = {
  id: 'high-fiber',
  version: RULE_VERSION_V1,
  name: 'High Fiber',
  category: 'positive',
  weight: 0.1,
  evaluator: (input) => {
    const fiber = num(input.nutrition?.fiber);
    if (fiber === undefined || fiber < 6) return noTrigger();
    return {
      triggered: true,
      score: 10,
      positive: { type: 'high_fiber', message: 'High in fiber' },
    };
  },
};

export const v1Rules: ReadonlyArray<HealthRule> = Object.freeze([
  sugarHigh,
  fatHigh,
  saturatedFatHigh,
  transFat,
  sodiumHigh,
  ultraProcessed,
  highProtein,
  highFiber,
]);
