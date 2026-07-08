import { ErrorCode } from '@/common/errors/error-codes';
import type { AuditLogService } from '@/observability/audit-log.service';

import type { CreateEndpointDto } from '../dto/create-endpoint.dto';
import type { WebhookEndpointsRepository } from '../repositories/webhook-endpoints.repository';
import {
  MAX_ENDPOINTS_PER_TENANT,
  WebhookEndpointsService,
  generateSecret,
} from '../services/webhook-endpoints.service';
import type { IWebhookTierPort } from '../types/webhook-tier.port';

/**
 * BE-50 — `WebhookEndpointsService` unit tests.
 *
 * Covers:
 *   - non-Pro tenant ⇒ `SUBSCRIPTION_REQUIRED` (HTTP 402),
 *   - 5-endpoint cap enforced,
 *   - SSRF guard runs on registration (rejects `http://10.0.0.1`),
 *   - secret is generated on the server (random hex, never user input),
 *   - audit log is written on create + delete,
 *   - delete on non-existent id ⇒ NOT_FOUND,
 *   - listing is tenant-scoped.
 */

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

const TENANT = '00000000-0000-0000-0000-000000000001';
const USER = '00000000-0000-0000-0000-000000000002';

function makeRepo(overrides: Partial<jest.Mocked<WebhookEndpointsRepository>> = {}) {
  const base = {
    create: jest.fn(),
    countActiveByTenant: jest.fn().mockResolvedValue(0),
    listByTenant: jest.fn().mockResolvedValue([]),
    findByIdForTenant: jest.fn(),
    findById: jest.fn(),
    deactivate: jest.fn().mockResolvedValue(true),
    findActiveSubscribers: jest.fn().mockResolvedValue([]),
  };
  return { ...base, ...overrides } as unknown as jest.Mocked<WebhookEndpointsRepository>;
}

function makeAudit(): jest.Mocked<AuditLogService> {
  return {
    logAction: jest.fn().mockResolvedValue(undefined),
    logBatch: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<AuditLogService>;
}

function makeTierPort(allowed: boolean): jest.Mocked<IWebhookTierPort> {
  return {
    isProTenant: jest.fn().mockResolvedValue(allowed),
  };
}

function makeService(opts: {
  repo?: jest.Mocked<WebhookEndpointsRepository>;
  audit?: jest.Mocked<AuditLogService>;
  tier?: jest.Mocked<IWebhookTierPort>;
} = {}) {
  const repo = opts.repo ?? makeRepo();
  const audit = opts.audit ?? makeAudit();
  const tier = opts.tier ?? makeTierPort(true);
  const service = new WebhookEndpointsService(repo, tier, audit);
  return { service, repo, audit, tier };
}

const validInput: CreateEndpointDto = {
  url: 'https://example.com/hook',
  events: ['product.created'],
};

const sampleRow = (overrides: Partial<EndpointRow> = {}): EndpointRow => ({
  id: '11111111-1111-1111-1111-111111111111',
  tenantId: TENANT,
  url: validInput.url,
  secret: 'srv-generated-secret',
  isActive: true,
  events: ['product.created'],
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
  ...overrides,
});

describe('WebhookEndpointsService', () => {
  describe('create', () => {
    it('creates an endpoint, generates a server-side secret, and writes audit', async () => {
      const repo = makeRepo({ create: jest.fn().mockResolvedValue(sampleRow()) });
      const { service, audit, tier } = makeService({ repo });

      const result = await service.create(TENANT, USER, validInput);

      expect(tier.isProTenant).toHaveBeenCalledWith(TENANT);
      expect(repo.create).toHaveBeenCalledTimes(1);
      const insertArg = repo.create.mock.calls[0][0];
      expect(insertArg.url).toBe(validInput.url);
      expect(insertArg.events).toEqual(['product.created']);
      expect(insertArg.tenantId).toBe(TENANT);
      // secret must be a hex string (32 bytes => 64 hex chars).
      expect(insertArg.secret).toMatch(/^[0-9a-f]{64}$/);

      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CREATE',
          resourceType: 'webhook_endpoint',
          tenantId: TENANT,
          userId: USER,
          success: true,
        }),
      );

      expect(result.url).toBe(validInput.url);
      expect(result.events).toEqual(['product.created']);
      expect(result.isActive).toBe(true);
    });

    it('rejects with SUBSCRIPTION_REQUIRED when tenant is not on Pro', async () => {
      const tier = makeTierPort(false);
      const { service } = makeService({ tier });

      await expect(service.create(TENANT, USER, validInput)).rejects.toMatchObject({
        code: ErrorCode.SUBSCRIPTION_REQUIRED,
      });
    });

    it('rejects with PLAN_LIMIT_EXCEEDED when 5 endpoints already exist', async () => {
      const repo = makeRepo({
        countActiveByTenant: jest.fn().mockResolvedValue(MAX_ENDPOINTS_PER_TENANT),
      });
      const { service } = makeService({ repo });

      await expect(service.create(TENANT, USER, validInput)).rejects.toMatchObject({
        code: ErrorCode.PLAN_LIMIT_EXCEEDED,
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses internal URLs at registration (SSRF guard)', async () => {
      const { service, repo } = makeService();
      await expect(
        service.create(TENANT, USER, { ...validInput, url: 'http://10.0.0.1/hook' }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('checks the cap AFTER the tier gate (so Pro upsell wins)', async () => {
      const repo = makeRepo({
        countActiveByTenant: jest.fn().mockResolvedValue(MAX_ENDPOINTS_PER_TENANT),
      });
      const tier = makeTierPort(false);
      const { service } = makeService({ repo, tier });

      await expect(service.create(TENANT, USER, validInput)).rejects.toMatchObject({
        code: ErrorCode.SUBSCRIPTION_REQUIRED,
      });
      expect(repo.countActiveByTenant).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('returns all active endpoints for the tenant', async () => {
      const repo = makeRepo({
        listByTenant: jest.fn().mockResolvedValue([sampleRow(), sampleRow({ id: 'b' })]),
      });
      const { service } = makeService({ repo });

      const list = await service.list(TENANT);

      expect(list).toHaveLength(2);
      expect(repo.listByTenant).toHaveBeenCalledWith(TENANT);
    });

    it('rejects non-Pro tenants with SUBSCRIPTION_REQUIRED', async () => {
      const tier = makeTierPort(false);
      const { service } = makeService({ tier });

      await expect(service.list(TENANT)).rejects.toMatchObject({
        code: ErrorCode.SUBSCRIPTION_REQUIRED,
      });
    });
  });

  describe('delete', () => {
    it('deactivates the endpoint and writes audit', async () => {
      const repo = makeRepo({
        findByIdForTenant: jest.fn().mockResolvedValue(sampleRow()),
        deactivate: jest.fn().mockResolvedValue(true),
      });
      const { service, audit } = makeService({ repo });

      await service.delete(TENANT, USER, sampleRow().id);

      expect(repo.deactivate).toHaveBeenCalledWith(sampleRow().id, TENANT);
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DELETE',
          resourceType: 'webhook_endpoint',
          resourceId: sampleRow().id,
          tenantId: TENANT,
          userId: USER,
          success: true,
        }),
      );
    });

    it('throws NOT_FOUND when the endpoint does not belong to the tenant', async () => {
      const repo = makeRepo({
        findByIdForTenant: jest.fn().mockResolvedValue(null),
      });
      const { service } = makeService({ repo });

      await expect(service.delete(TENANT, USER, 'missing')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(repo.deactivate).not.toHaveBeenCalled();
    });
  });

  describe('generateSecret', () => {
    it('produces a 64-character hex string (32 random bytes)', () => {
      const a = generateSecret();
      const b = generateSecret();
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(b).toMatch(/^[0-9a-f]{64}$/);
      expect(a).not.toBe(b);
    });
  });
});
