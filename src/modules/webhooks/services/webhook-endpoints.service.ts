import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  CreateEndpointDto,
  WebhookEndpointDto,
} from '../dto/create-endpoint.dto';
import { WebhookEventName } from '../dto/webhook-events.types';
import { WebhookEndpointsRepository } from '../repositories/webhook-endpoints.repository';
import {
  IWebhookTierPort,
  WEBHOOK_TIER_PORT,
} from '../types/webhook-tier.port';
import { validateWebhookUrl } from '../utils/url-validator.util';

/**
 * BE-50 — Endpoint CRUD with the business rules wrapped around it:
 *   - Pro tier check (via the injected `WEBHOOK_TIER_PORT`),
 *   - hard cap of 5 active endpoints per tenant,
 *   - SSRF-safe URL validation at registration time,
 *   - random 32-byte secret generation on create,
 *   - audit log on every state-changing call.
 *
 * The repository handles the SQL; this service is the gatekeeper.
 */
export const MAX_ENDPOINTS_PER_TENANT = 5;
export const SECRET_BYTE_LENGTH = 32; // 256-bit HMAC key

@Injectable()
export class WebhookEndpointsService {
  constructor(
    private readonly repo: WebhookEndpointsRepository,
    @Inject(WEBHOOK_TIER_PORT)
    private readonly tier: IWebhookTierPort,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Register a new endpoint. Order of checks matters — we want the
   * tier 402 to surface before "you already have 5" so the upsell
   * message is clear.
   */
  async create(
    tenantId: string,
    userId: string,
    input: CreateEndpointDto,
  ): Promise<WebhookEndpointDto> {
    await this.assertProTier(tenantId);

    const urlCheck = validateWebhookUrl(input.url);
    if (!urlCheck.ok) {
      throw new BusinessException(
        ErrorCode.INVALID_INPUT,
        urlCheck.reason ?? 'URL is not allowed',
        { field: 'url', value: input.url },
      );
    }

    const existingCount = await this.repo.countActiveByTenant(tenantId);
    if (existingCount >= MAX_ENDPOINTS_PER_TENANT) {
      throw new BusinessException(
        ErrorCode.PLAN_LIMIT_EXCEEDED,
        `Webhook endpoint limit reached (${MAX_ENDPOINTS_PER_TENANT} per tenant)`,
        { metadata: { limit: MAX_ENDPOINTS_PER_TENANT, current: existingCount } },
      );
    }

    const secret = generateSecret();
    const row = await this.repo.create({
      tenantId,
      url: input.url,
      secret,
      events: input.events,
      isActive: true,
    });

    void this.audit.logAction({
      action: 'CREATE',
      resourceType: 'webhook_endpoint',
      resourceId: row.id,
      userId,
      tenantId,
      success: true,
      metadata: {
        url: row.url,
        events: row.events,
      },
    });

    return toDto(row);
  }

  /** List every active endpoint for the calling tenant. */
  async list(tenantId: string): Promise<WebhookEndpointDto[]> {
    await this.assertProTier(tenantId);
    const rows = await this.repo.listByTenant(tenantId);
    return rows.map(toDto);
  }

  /**
   * Soft-delete an endpoint. 404s if the id doesn't belong to this
   * tenant or no longer exists.
   */
  async delete(tenantId: string, userId: string, id: string): Promise<void> {
    await this.assertProTier(tenantId);

    const existing = await this.repo.findByIdForTenant(id, tenantId);
    if (!existing) {
      throw new BusinessException(ErrorCode.NOT_FOUND, 'Webhook endpoint not found', {
        metadata: { id },
      });
    }

    const ok = await this.repo.deactivate(id, tenantId);
    if (!ok) {
      throw new BusinessException(ErrorCode.NOT_FOUND, 'Webhook endpoint not found', {
        metadata: { id },
      });
    }

    void this.audit.logAction({
      action: 'DELETE',
      resourceType: 'webhook_endpoint',
      resourceId: id,
      userId,
      tenantId,
      success: true,
    });
  }

  /**
   * Throws `SUBSCRIPTION_REQUIRED` (HTTP 402 via the canonical map)
   * when the tenant is not on the Pro plan. Public so the controller
   * can short-circuit on the listing endpoint as well.
   */
  async assertProTier(tenantId: string): Promise<void> {
    const allowed = await this.tier.isProTenant(tenantId);
    if (!allowed) {
      throw new BusinessException(
        ErrorCode.SUBSCRIPTION_REQUIRED,
        'Webhooks require the Pro plan',
        { metadata: { tenantId, requiredPlan: 'pro' } },
      );
    }
  }
}

/** Convert a DB row to its public wire shape. */
function toDto(row: {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  isActive: boolean;
  events: string[];
  createdAt: Date;
  updatedAt: Date;
}): WebhookEndpointDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    url: row.url,
    secret: row.secret,
    isActive: row.isActive,
    events: row.events as WebhookEventName[],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Generate a 32-byte random secret encoded as hex. Sufficient for
 * HMAC-SHA256 signing per RFC 2104. We hex-encode (not base64) so
 * receivers can paste it into curl one-liners without quoting hell.
 */
export function generateSecret(): string {
  return randomBytes(SECRET_BYTE_LENGTH).toString('hex');
}
