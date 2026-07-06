import { Injectable } from '@nestjs/common';

import type { ConsumptionGuidance, ScoringInput, ScoringOutput } from '../types/health.types';

/**
 * BE-12 v2 ADDENDUM — consumption guidance.
 *
 * Generates short, deterministic guidance text from the same inputs
 * the scoring engine consumed. Uses templated English copy keyed on
 * the overall grade and the dominant signals; localisation hooks
 * (Hindi/Tamil/Telugu/Bengali/Marathi — Req 34) land in BE-39.
 *
 * Cadence map:
 *   A → daily
 *   B → daily / weekly
 *   C → occasional
 *   D → rare
 *   E → avoid
 */
@Injectable()
export class ConsumptionGuidanceService {
  generate(input: ScoringInput, output: ScoringOutput): ConsumptionGuidance {
    const cadence = this.cadenceFor(output);
    const portion = this.portionFor(input);
    const summary = this.summary(output, cadence);
    const notes = this.notes(input, output);
    return {
      cadence,
      portionGrams: portion,
      summary,
      notes,
    };
  }

  private cadenceFor(out: ScoringOutput): ConsumptionGuidance['cadence'] {
    if (out.healthStatus === 'data_unavailable') return 'occasional';
    switch (out.overallGrade) {
      case 'A':
        return 'daily';
      case 'B':
        return 'daily';
      case 'C':
        return 'occasional';
      case 'D':
        return 'rare';
      case 'E':
        return 'avoid';
      default:
        return 'occasional';
    }
  }

  private portionFor(input: ScoringInput): number | undefined {
    const serving = input.nutrition?.servingSize;
    if (serving === null || serving === undefined) return undefined;
    const n = typeof serving === 'number' ? serving : Number(serving);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  }

  private summary(out: ScoringOutput, cadence: ConsumptionGuidance['cadence']): string {
    if (out.healthStatus === 'data_unavailable') {
      return 'Nutrition data unavailable. Limit consumption until verified.';
    }
    const map: Record<ConsumptionGuidance['cadence'], string> = {
      daily: 'Suitable for daily consumption in moderation.',
      weekly: 'Best limited to a few times per week.',
      occasional: 'Best treated as an occasional choice.',
      rare: 'Limit to once or twice a month.',
      avoid: 'Best avoided. Look for healthier alternatives.',
    };
    return map[cadence];
  }

  private notes(input: ScoringInput, out: ScoringOutput): string[] {
    const notes: string[] = [];
    for (const w of out.warnings) {
      switch (w.type) {
        case 'high_sugar':
          notes.push('High sugar — pair with protein/fiber to slow absorption.');
          break;
        case 'high_oil':
          notes.push('High fat — keep portion small and balance with vegetables.');
          break;
        case 'high_saturated_fat':
          notes.push('Saturated fat is elevated — limit to small portions.');
          break;
        case 'trans_fat':
          notes.push('Trans fat detected — strongly recommended to avoid.');
          break;
        case 'high_sodium':
          notes.push('High sodium — drink extra water and watch overall daily intake.');
          break;
        case 'ultra_processed':
          notes.push('Ultra-processed — fresh whole-food alternatives are preferable.');
          break;
        default:
          break;
      }
    }
    if (out.positives.some((p) => p.type === 'high_protein')) {
      notes.push('Good source of protein.');
    }
    if (out.positives.some((p) => p.type === 'high_fiber')) {
      notes.push('High in fiber — supports digestion.');
    }
    if (notes.length === 0 && input.nutrition) {
      notes.push('Within healthy limits when eaten in normal portions.');
    }
    return notes;
  }
}
