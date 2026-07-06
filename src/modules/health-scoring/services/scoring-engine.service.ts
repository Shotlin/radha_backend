import { Injectable } from '@nestjs/common';

import { RULE_VERSION_V1, v1Rules } from '../rules/v1-rules';
import type {
  HealthGrade,
  HealthRule,
  HealthStatus,
  ProcessingLevel,
  RuleValidationResult,
  ScoringInput,
  ScoringOutput,
} from '../types/health.types';

import { AllergenDetectionService } from './allergen-detection.service';
import { ChildSafetyService } from './child-safety.service';

/**
 * BE-12 — Scoring engine.
 *
 * Pure: same input ⇒ same output. The output is what gets persisted
 * into `product_health_assessments`.
 *
 * Versioning: each rule set is registered in `ruleSets`. Older
 * versions stay queryable so historical assessments remain
 * reconstructible — important for compliance and A/B testing of new
 * rule versions.
 */
@Injectable()
export class ScoringEngineService {
  private readonly ruleSets: ReadonlyMap<string, ReadonlyArray<HealthRule>> = new Map([
    [RULE_VERSION_V1, v1Rules],
  ]);

  constructor(
    private readonly childSafety: ChildSafetyService,
    private readonly allergenService: AllergenDetectionService,
  ) {}

  evaluate(input: ScoringInput): ScoringOutput {
    const version = input.ruleVersion ?? RULE_VERSION_V1;
    const rules = this.getRules(version);

    // Missing nutrition: produce a deterministic 'data_unavailable' verdict.
    if (!input.nutrition) {
      return this.unknownAssessment(input, version);
    }

    const warnings: ScoringOutput['warnings'] = [];
    const positives: ScoringOutput['positives'] = [];
    const tags = new Set<string>();
    let total = 100;

    for (const rule of rules) {
      const r = rule.evaluator(input);
      if (!r.triggered) continue;
      total += r.score;
      if (r.warning) {
        warnings.push(r.warning);
        tags.add(r.warning.type);
      }
      if (r.positive) {
        positives.push(r.positive);
        tags.add(r.positive.type);
      }
    }

    total = Math.max(0, Math.min(100, total));
    const grade = this.scoreToGrade(total);
    const isProcessed = (input.nutrition.isProcessed as ProcessingLevel) ?? 'unknown';
    const childSafety = this.childSafety.evaluateForChildren(input);
    const allergens = this.allergenService.detectAllergens(input.product, input.nutrition);

    return {
      productId: input.product.id,
      overallGrade: grade,
      overallScore: total,
      healthStatus: this.gradeToStatus(grade),
      childSafety,
      warnings,
      positives,
      allergens,
      isProcessed,
      tags: [...tags],
      ruleVersion: version,
      computedAt: new Date(),
    };
  }

  getRules(version: string): ReadonlyArray<HealthRule> {
    return this.ruleSets.get(version) ?? v1Rules;
  }

  validateRules(rules: ReadonlyArray<HealthRule>): RuleValidationResult {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const rule of rules) {
      if (seen.has(rule.id)) {
        errors.push(`Duplicate rule id: ${rule.id}`);
      }
      seen.add(rule.id);
      if (!Number.isFinite(rule.weight) || rule.weight < 0 || rule.weight > 1) {
        errors.push(`Rule ${rule.id} has invalid weight ${rule.weight}`);
      }
      if (typeof rule.evaluator !== 'function') {
        errors.push(`Rule ${rule.id} is missing an evaluator`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  scoreToGrade(score: number): HealthGrade {
    if (score >= 80) return 'A';
    if (score >= 60) return 'B';
    if (score >= 40) return 'C';
    if (score >= 20) return 'D';
    return 'E';
  }

  gradeToStatus(grade: HealthGrade): HealthStatus {
    switch (grade) {
      case 'A':
      case 'B':
        return 'green';
      case 'C':
        return 'yellow';
      case 'D':
      case 'E':
        return 'red';
      case 'U':
      default:
        return 'data_unavailable';
    }
  }

  private unknownAssessment(input: ScoringInput, version: string): ScoringOutput {
    const allergens = this.allergenService.detectAllergens(input.product, undefined);
    return {
      productId: input.product.id,
      overallGrade: 'U',
      overallScore: 50,
      healthStatus: 'data_unavailable',
      childSafety: { status: 'unknown', reasons: ['Nutrition data unavailable'] },
      warnings: [
        {
          type: 'insufficient_data',
          severity: 'low',
          message: 'Insufficient nutrition data for assessment',
          threshold: 0,
          actual: 0,
          unit: 'fields',
        },
      ],
      positives: [],
      allergens,
      isProcessed: 'unknown',
      tags: ['insufficient_data'],
      ruleVersion: version,
      computedAt: new Date(),
    };
  }
}
