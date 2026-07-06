import { z } from 'zod';

import { WEBHOOK_EVENT_VALUES, WebhookEventName } from './webhook-events.types';

/**
 * BE-50 — `POST /webhooks/endpoints` request DTO.
 *
 * Validation rules:
 *   - `url` must be a valid HTTP(S) URL. Internal-IP and link-local
 *     URLs are rejected by `url-validator.util.ts` (SSRF guard) at
 *     the service layer; we don't bake that into the schema so dev
 *     tooling can still register a localhost listener.
 *   - `events` must be a non-empty list of recognised event names.
 *     Unknown values are rejected so a typo is caught before we
 *     ever try to fan out.
 */
export const CreateEndpointSchema = z.object({
  url: z.string().url().max(2048),
  events: z
    .array(
      z.enum([WEBHOOK_EVENT_VALUES[0], ...WEBHOOK_EVENT_VALUES.slice(1)] as [
        WebhookEventName,
        ...WebhookEventName[],
      ]),
    )
    .min(1, 'At least one event must be specified')
    .max(WEBHOOK_EVENT_VALUES.length),
});

export type CreateEndpointDto = z.infer<typeof CreateEndpointSchema>;

/**
 * Response shape: the tenant gets the full endpoint row (including
 * the freshly-generated `secret`) on creation; subsequent listings
 * still return the secret since this is a server-to-server contract
 * and the secret is required to verify signatures.
 */
export interface WebhookEndpointDto {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  isActive: boolean;
  events: WebhookEventName[];
  createdAt: string;
  updatedAt: string;
}
