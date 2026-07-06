/**
 * BE-50 — Pro-tier check port.
 *
 * The webhooks module needs to know whether a tenant is on the Pro
 * plan before it lets them register or list endpoints. Today (BE-50
 * v1) the real subscription/entitlement plumbing for Pro is being
 * finalised in BE-08 v2, so we depend on this thin port and ship a
 * stub that returns `true` everywhere. When BE-08 v2 lands, the
 * binding in `webhooks.module.ts` flips to a real implementation
 * that consults `EntitlementsService` and the rest of the module
 * stays unchanged.
 *
 * Ports live in `types/` so the contract is easy to find and so the
 * stub doesn't drag any subscription module imports into webhook
 * tests.
 */
export interface IWebhookTierPort {
  /** Returns `true` iff the given tenant has the Pro entitlement. */
  isProTenant(tenantId: string): Promise<boolean>;
}

export const WEBHOOK_TIER_PORT = Symbol('WEBHOOK_TIER_PORT');

/**
 * Default stub used until BE-08 v2 is wired in. Returns `true` so
 * Pro-only routes don't block the rest of the BE-50 work; tests that
 * need to exercise the 402 branch override this provider.
 */
export class StubProTierPort implements IWebhookTierPort {
  async isProTenant(_tenantId: string): Promise<boolean> {
    return true;
  }
}
