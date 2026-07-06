import { z } from 'zod';

import { WEBHOOK_EVENT_VALUES, WebhookEventName } from './webhook-events.types';

/**
 * BE-50 — DTOs for the deliveries listing + replay endpoints.
 *
 * `GET /webhooks/deliveries?status=&limit=` filters historical
 * attempts so the dashboard can surface failures and let the operator
 * trigger a manual replay for any that still matter.
 */

export const DeliveryStatusValues = ['pending', 'succeeded', 'failed'] as const;
export type DeliveryStatus = (typeof DeliveryStatusValues)[number];

export const ListDeliveriesQuerySchema = z.object({
  status: z.enum(DeliveryStatusValues).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export type ListDeliveriesQueryDto = z.infer<typeof ListDeliveriesQuerySchema>;

/**
 * Replay accepts an empty body — the controller pulls the delivery
 * by `:id` and re-queues it. The schema is here so the pipe can still
 * give a uniform 400 envelope for any garbage that does come in.
 */
export const ReplayDeliverySchema = z.object({}).passthrough();
export type ReplayDeliveryDto = z.infer<typeof ReplayDeliverySchema>;

/** Wire shape of a single delivery row in API responses. */
export interface WebhookDeliveryDto {
  id: string;
  endpointId: string;
  eventName: WebhookEventName | string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastStatusCode: number | null;
  nextRetryAt: string | null;
  expiresAt: string;
  createdAt: string;
}
