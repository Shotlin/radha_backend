import { Injectable } from '@nestjs/common';

import { DomainConflictException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';
import { DbService } from '@/db/db.service';
import { TenantRow, StoreRow, stores, tenants, userStoreAccess } from '@/db/schema/tenants';
import { UserRow, users } from '@/db/schema/users';
import { AuditLogService } from '@/observability/audit-log.service';

import { OnboardTenantDto } from '../dto/onboard-tenant.dto';
import { TenantsRepository } from '../repositories/tenants.repository';

const RESERVED_SUBDOMAINS = new Set([
  'admin',
  'api',
  'www',
  'app',
  'support',
  'help',
  'demo',
  'mail',
  'staging',
  'public',
]);

export interface OnboardingResult {
  tenant: TenantRow;
  owner: UserRow;
  store: StoreRow;
  trialEndsAt: Date;
}

/**
 * BE-09 self-service onboarding.
 *
 *   - Validates subdomain.
 *   - In a single transaction: creates tenant + owner + first store +
 *     user_store_access(admin).
 *   - Trial end-date is set to +90 days; the actual subscription row
 *     is created in BE-28.
 */
@Injectable()
export class TenantOnboardingService {
  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantsRepository,
    private readonly audit: AuditLogService,
    private readonly _config: ConfigService,
  ) {}

  async validateSubdomain(subdomain: string): Promise<{ valid: boolean; reason?: string }> {
    if (RESERVED_SUBDOMAINS.has(subdomain)) {
      return { valid: false, reason: 'Reserved subdomain' };
    }
    const existing = await this.tenants.findBySubdomain(subdomain);
    if (existing) return { valid: false, reason: 'Subdomain already taken' };
    return { valid: true };
  }

  async onboard(dto: OnboardTenantDto): Promise<OnboardingResult> {
    const check = await this.validateSubdomain(dto.subdomain);
    if (!check.valid) {
      throw new DomainConflictException(
        check.reason ?? 'Subdomain unavailable',
        ErrorCode.DUPLICATE_RESOURCE,
        { metadata: { subdomain: dto.subdomain } },
      );
    }

    const result = await this.db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({
          name: dto.businessName,
          kind: 'business',
          status: 'trial',
          subdomain: dto.subdomain,
          plan: 'trial',
          industry: dto.industry,
          country: dto.country,
          contactEmail: dto.email,
          contactMobile: dto.mobile,
        })
        .returning();

      const [owner] = await tx
        .insert(users)
        .values({
          tenantId: tenant.id,
          mobile: dto.mobile,
          email: dto.email,
          name: dto.ownerName,
          role: 'owner',
          subscriptionTier: 'trial_pro',
          isVerified: false,
          isActive: true,
        })
        .returning();

      const [store] = await tx
        .insert(stores)
        .values({
          tenantId: tenant.id,
          name: dto.storeName,
          code: 'STORE-001',
          type: 'retail',
          addressLine1: dto.storeAddress,
          city: dto.storeCity,
          state: dto.storeState,
          pincode: dto.storePincode,
          createdBy: owner.id,
        })
        .returning();

      await tx.insert(userStoreAccess).values({
        userId: owner.id,
        storeId: store.id,
        accessLevel: 'admin',
        isActive: true,
        grantedBy: owner.id,
      });

      return {
        tenant: tenant as TenantRow,
        owner: owner as UserRow,
        store: store as StoreRow,
      };
    });

    await this.audit.logAction({
      action: 'CREATE',
      resourceType: 'Tenant',
      resourceId: result.tenant.id,
      userId: result.owner.id,
      tenantId: result.tenant.id,
      success: true,
      metadata: { onboarding: true, subdomain: dto.subdomain },
    });

    return {
      ...result,
      trialEndsAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    };
  }
}
