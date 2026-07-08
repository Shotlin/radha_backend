import { DEFAULT_PLANS, PLAN_ORDER } from '../constants/default-plans';

describe('DEFAULT_PLANS catalog', () => {
  it('ships exactly 4 plans (trial, starter ₹49, growth ₹99, pro ₹199)', () => {
    expect(DEFAULT_PLANS).toHaveLength(4);
    const codes = DEFAULT_PLANS.map((p) => p.code);
    expect(codes).toEqual(['trial', 'starter', 'growth', 'pro']);
  });

  it('uses the canonical INR pricing from the spec', () => {
    const byCode = Object.fromEntries(DEFAULT_PLANS.map((p) => [p.code, p]));
    expect(byCode.trial.price).toBe(0);
    expect(byCode.starter.price).toBe(49);
    expect(byCode.growth.price).toBe(99);
    expect(byCode.pro.price).toBe(199);
  });

  it('keeps the trial plan private and 90 days long', () => {
    const trial = DEFAULT_PLANS.find((p) => p.code === 'trial');
    expect(trial?.isPublic).toBe(false);
    expect(trial?.trialDays).toBe(90);
  });

  it('publicly lists starter / growth / pro', () => {
    for (const code of ['starter', 'growth', 'pro'] as const) {
      const plan = DEFAULT_PLANS.find((p) => p.code === code);
      expect(plan?.isPublic).toBe(true);
      expect(plan?.isActive).toBe(true);
    }
  });

  it('marks pro as fully unlimited on stores / users / scans / reports / EAN lists / AI OCR', () => {
    const pro = DEFAULT_PLANS.find((p) => p.code === 'pro');
    const unlimited = pro?.features.filter((f) => f.limit === 'unlimited').map((f) => f.feature);
    expect(unlimited).toEqual(
      expect.arrayContaining([
        'stores',
        'users',
        'monthly_scans',
        'monthly_reports',
        'ean_lists',
        'ai_ocr',
      ]),
    );
  });

  it('every plan declares the core gating features', () => {
    const required = ['stores', 'users', 'monthly_scans', 'monthly_reports'];
    for (const plan of DEFAULT_PLANS) {
      const featureCodes = plan.features.map((f) => f.feature);
      for (const r of required) {
        expect(featureCodes).toContain(r);
      }
    }
  });

  it('PLAN_ORDER lists tiers in ascending pricing order', () => {
    expect(PLAN_ORDER).toEqual(['trial', 'starter', 'growth', 'pro']);
  });
});
