/**
 * BE-50 — Catalogue of every event the backend can fan out via the
 * outbound-webhook channel.
 *
 * The string values are the on-the-wire names that:
 *   - Pro tenants use when they register an endpoint
 *     (`{ events: ['product.created', ...] }`),
 *   - we ship inside the `X-Radha-Event` header on every delivery,
 *   - the mobile dashboard / replay screen filter on.
 *
 * Adding a new event:
 *   1. add a member to this enum,
 *   2. emit it from the owning module via `WebhookEmitterService`,
 *   3. document the payload contract in `API_CONTRACTS.md`.
 */
export enum WebhookEvent {
  ProductCreated = 'product.created',
  ProductUpdated = 'product.updated',
  InventoryUpdated = 'inventory.updated',
  GrnPosted = 'grn.posted',
  TaskCompleted = 'task.completed',
  ScanSessionEnded = 'scan_session.ended',
}

/** Type-narrow alias used across services for the union of event names. */
export type WebhookEventName = `${WebhookEvent}`;

/** Frozen list of every valid event name — used by Zod schemas + tests. */
export const WEBHOOK_EVENT_VALUES: readonly WebhookEventName[] = Object.freeze(
  Object.values(WebhookEvent) as WebhookEventName[],
);

export const isWebhookEvent = (value: unknown): value is WebhookEventName =>
  typeof value === 'string' && (WEBHOOK_EVENT_VALUES as readonly string[]).includes(value);
