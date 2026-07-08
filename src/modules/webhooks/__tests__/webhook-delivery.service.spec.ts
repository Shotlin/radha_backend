import { createHmac } from 'node:crypto';

import type { LoggerService } from '@/logging/logger.service';

import type { WebhookDeliveriesRepository } from '../repositories/webhook-deliveries.repository';
import type { WebhookEndpointsRepository } from '../repositories/webhook-endpoints.repository';
import {
  HttpFetcher,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_BACKOFF_MINUTES,
  WebhookDeliveryService,
} from '../services/webhook-delivery.service';

/**
 * BE-50 — `WebhookDeliveryService` unit tests.
 *
 * Covers:
 *   - HMAC-SHA256 signing matches an independent computation,
 *   - request headers carry signature / event / delivery id,
 *   - 2xx response → `markSucceeded`,
 *   - non-2xx response → `markRetry` with the correct backoff,
 *   - exponential backoff schedule (1m, 5m, 15m, 30m, 60m),
 *   - 5-attempt cap → permanent failure, no further retry,
 *   - SSRF guard refuses internal URLs at delivery time,
 *   - deactivated endpoint → retry-as-failure path,
 *   - missing delivery / endpoint → safe skip.
 */

type DeliveryRow = {
  id: string;
  endpointId: string;
  eventName: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'succeeded' | 'failed';
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string | null;
  lastStatusCode: number | null;
  nextRetryAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
};

type EndpointRow = {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  isActive: boolean;
  events: string[];
  createdAt: Date;
  updatedAt: Date;
};

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    logError: jest.fn(),
  }) as unknown as LoggerService;

function buildDelivery(overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id: 'd-1',
    endpointId: 'e-1',
    eventName: 'product.created',
    payload: { id: 'p-1', name: 'Atta 5kg' },
    status: 'pending',
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    lastStatusCode: null,
    nextRetryAt: null,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    ...overrides,
  };
}

function buildEndpoint(overrides: Partial<EndpointRow> = {}): EndpointRow {
  return {
    id: 'e-1',
    tenantId: 't-1',
    url: 'https://example.com/hook',
    secret: 'super-secret',
    isActive: true,
    events: ['product.created'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildService(opts: {
  delivery?: DeliveryRow | null;
  endpoint?: EndpointRow | null;
} = {}) {
  const deliveryRow: DeliveryRow | null =
    opts.delivery === undefined ? buildDelivery() : opts.delivery;
  const endpointRow: EndpointRow | null =
    opts.endpoint === undefined ? buildEndpoint() : opts.endpoint;

  const deliveriesRepo = {
    findById: jest.fn().mockResolvedValue(deliveryRow),
    markSucceeded: jest.fn().mockResolvedValue(undefined),
    markRetry: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<WebhookDeliveriesRepository>;

  const endpointsRepo = {
    findById: jest.fn().mockResolvedValue(endpointRow),
  } as unknown as jest.Mocked<WebhookEndpointsRepository>;

  const service = new WebhookDeliveryService(endpointsRepo, deliveriesRepo, buildLogger());

  return { service, deliveriesRepo, endpointsRepo, deliveryRow: deliveryRow!, endpointRow: endpointRow! };
}

describe('WebhookDeliveryService', () => {
  describe('signHmacSha256', () => {
    it('matches a fresh HMAC-SHA256 computation over the same body', () => {
      const { service } = buildService();
      const body = JSON.stringify({ hello: 'world' });
      const secret = 'shhhh';
      const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
      expect(service.signHmacSha256(body, secret)).toBe(expected);
    });

    it('produces different signatures for different secrets', () => {
      const { service } = buildService();
      const body = '{"x":1}';
      expect(service.signHmacSha256(body, 'k1')).not.toBe(service.signHmacSha256(body, 'k2'));
    });
  });

  describe('deliver', () => {
    it('marks the row succeeded on a 200 response', async () => {
      const { service, deliveriesRepo } = buildService();
      const fetcher: HttpFetcher = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      const result = await service.deliver('d-1', fetcher);

      expect(result.status).toBe('succeeded');
      expect(result.statusCode).toBe(200);
      expect(deliveriesRepo.markSucceeded).toHaveBeenCalledWith(
        'd-1',
        200,
        expect.any(Date),
      );
      expect(deliveriesRepo.markRetry).not.toHaveBeenCalled();
    });

    it('sends the signature, event, and delivery-id headers', async () => {
      const { service, deliveryRow, endpointRow } = buildService();
      const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
      const fetcher: HttpFetcher = jest.fn().mockImplementation(async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 204, text: () => Promise.resolve('') };
      });

      await service.deliver('d-1', fetcher);

      expect(calls).toHaveLength(1);
      const { headers, body } = calls[0].init;
      expect(headers['Content-Type']).toBe('application/json');
      const expectedSig = createHmac('sha256', endpointRow.secret)
        .update(body, 'utf8')
        .digest('hex');
      expect(headers['X-Radha-Signature']).toBe(`sha256=${expectedSig}`);
      expect(headers['X-Radha-Event']).toBe(deliveryRow.eventName);
      expect(headers['X-Radha-Delivery-Id']).toBe(deliveryRow.id);
      expect(body).toBe(JSON.stringify(deliveryRow.payload));
    });

    it('schedules a 1-minute retry after the first failed attempt', async () => {
      const { service, deliveriesRepo } = buildService();
      const fetcher: HttpFetcher = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') });

      const before = Date.now();
      const result = await service.deliver('d-1', fetcher);
      const after = Date.now();

      expect(result.status).toBe('failed');
      expect(result.permanentlyFailed).toBe(false);
      expect(result.statusCode).toBe(500);

      expect(deliveriesRepo.markRetry).toHaveBeenCalledTimes(1);
      const args = deliveriesRepo.markRetry.mock.calls[0][1];
      expect(args.permanentlyFailed).toBe(false);
      expect(args.statusCode).toBe(500);
      expect(args.error).toMatch(/HTTP 500/);
      expect(args.nextRetryAt).toBeInstanceOf(Date);
      const delta = args.nextRetryAt!.getTime() - before;
      // ~60s — give a 1s window so the test is stable on slow CI.
      expect(delta).toBeGreaterThanOrEqual(60_000 - 50);
      expect(delta).toBeLessThanOrEqual(60_000 + (after - before) + 50);
    });

    it.each([
      [0, RETRY_BACKOFF_MINUTES[0]], // attempt 1 → 1m
      [1, RETRY_BACKOFF_MINUTES[1]], // attempt 2 → 5m
      [2, RETRY_BACKOFF_MINUTES[2]], // attempt 3 → 15m
      [3, RETRY_BACKOFF_MINUTES[3]], // attempt 4 → 30m
    ])('uses correct backoff for failure on attempts=%d', async (attemptsBefore, minutes) => {
      const { service, deliveriesRepo } = buildService({
        delivery: buildDelivery({ attempts: attemptsBefore }),
      });
      const fetcher: HttpFetcher = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 502, text: () => Promise.resolve('') });

      const before = Date.now();
      const result = await service.deliver('d-1', fetcher);

      expect(result.permanentlyFailed).toBe(false);
      expect(result.nextRetryAt).toBeInstanceOf(Date);
      const expected = before + minutes * 60_000;
      const actual = result.nextRetryAt!.getTime();
      expect(actual).toBeGreaterThanOrEqual(expected - 50);
      expect(actual).toBeLessThanOrEqual(expected + 5_000);

      expect(deliveriesRepo.markRetry).toHaveBeenCalledTimes(1);
    });

    it('marks the delivery permanently failed after the 5th attempt', async () => {
      const { service, deliveriesRepo } = buildService({
        delivery: buildDelivery({ attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
      });
      const fetcher: HttpFetcher = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('') });

      const result = await service.deliver('d-1', fetcher);

      expect(result.status).toBe('failed');
      expect(result.permanentlyFailed).toBe(true);
      expect(result.nextRetryAt).toBeNull();

      const args = deliveriesRepo.markRetry.mock.calls[0][1];
      expect(args.permanentlyFailed).toBe(true);
      expect(args.nextRetryAt).toBeNull();
    });

    it('treats network errors as a regular failure (subject to backoff)', async () => {
      const { service, deliveriesRepo } = buildService();
      const fetcher: HttpFetcher = jest
        .fn()
        .mockRejectedValue(new Error('ECONNRESET'));

      const result = await service.deliver('d-1', fetcher);

      expect(result.status).toBe('failed');
      expect(result.permanentlyFailed).toBe(false);
      expect(deliveriesRepo.markRetry).toHaveBeenCalledTimes(1);
      const args = deliveriesRepo.markRetry.mock.calls[0][1];
      expect(args.error).toContain('ECONNRESET');
      expect(args.statusCode).toBeNull();
    });

    it('refuses to deliver to internal URLs (SSRF guard) and fails permanently', async () => {
      const { service, deliveriesRepo } = buildService({
        endpoint: buildEndpoint({ url: 'http://10.0.0.1/hook' }),
      });
      const fetcher: HttpFetcher = jest.fn();

      const result = await service.deliver('d-1', fetcher);

      expect(fetcher).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.permanentlyFailed).toBe(true);
      const args = deliveriesRepo.markRetry.mock.calls[0][1];
      expect(args.error).toMatch(/SSRF/i);
      expect(args.permanentlyFailed).toBe(true);
      expect(args.nextRetryAt).toBeNull();
    });

    it('skips silently when the delivery row is missing', async () => {
      const { service, deliveriesRepo } = buildService({ delivery: null });
      const fetcher: HttpFetcher = jest.fn();
      const result = await service.deliver('d-1', fetcher);

      expect(result.status).toBe('skipped');
      expect(fetcher).not.toHaveBeenCalled();
      expect(deliveriesRepo.markSucceeded).not.toHaveBeenCalled();
      expect(deliveriesRepo.markRetry).not.toHaveBeenCalled();
    });

    it('schedules a retry when the endpoint has been deactivated', async () => {
      const { service, deliveriesRepo } = buildService({
        endpoint: buildEndpoint({ isActive: false }),
      });
      const fetcher: HttpFetcher = jest.fn();
      const result = await service.deliver('d-1', fetcher);

      expect(fetcher).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(deliveriesRepo.markRetry).toHaveBeenCalledTimes(1);
    });
  });
});
