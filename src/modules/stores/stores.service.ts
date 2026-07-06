import { Injectable } from '@nestjs/common';

import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditLogService } from '@/observability/audit-log.service';

import { TenantsRepository } from '../tenants/repositories/tenants.repository';
import { CreateStoreDto, GrantStoreAccessDto } from '../tenants/dto/onboard-tenant.dto';
import { StoresRepository } from './repositories/stores.repository';
import { UserStoreAccessRepository } from './repositories/user-store-access.repository';
import type { StoreRow, UserStoreAccessRow } from '@/db/schema/tenants';

@Injectable()
export class StoresService {
  constructor(
    private readonly stores: StoresRepository,
    private readonly access: UserStoreAccessRepository,
    private readonly tenants: TenantsRepository,
    private readonly audit: AuditLogService,
  ) {}

  async list(tenantId: string): Promise<StoreRow[]> {
    return this.stores.listForTenant(tenantId);
  }

  async get(tenantId: string, storeId: string): Promise<StoreRow> {
    const row = await this.stores.findByTenantAndId(tenantId, storeId);
    if (!row) throw new DomainNotFoundException('Store', storeId);
    return row;
  }

  async create(tenantId: string, byUserId: string, dto: CreateStoreDto): Promise<StoreRow> {
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant) throw new DomainNotFoundException('Tenant', tenantId);
    if (tenant.kind !== 'business') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Stores can only be created under a business tenant',
        { metadata: { tenantId, kind: tenant.kind } },
      );
    }
    const store = await this.stores.create({
      tenantId,
      name: dto.name,
      code: dto.code,
      type: dto.type,
      addressLine1: dto.addressLine1,
      city: dto.city,
      state: dto.state,
      pincode: dto.pincode,
      createdBy: byUserId,
    });
    await this.audit.logAction({
      action: 'CREATE',
      resourceType: 'Store',
      resourceId: store.id,
      userId: byUserId,
      tenantId,
      success: true,
    });
    return store;
  }

  async grantAccess(
    tenantId: string,
    storeId: string,
    byUserId: string,
    dto: GrantStoreAccessDto,
  ): Promise<UserStoreAccessRow> {
    await this.get(tenantId, storeId); // ensures store exists in tenant
    const existing = await this.access.findActive(dto.userId, storeId);
    if (existing) {
      // upgrade in place
      return existing;
    }
    const row = await this.access.create({
      userId: dto.userId,
      storeId,
      accessLevel: dto.accessLevel,
      isActive: true,
      grantedBy: byUserId,
    });
    await this.audit.logAction({
      action: 'GRANT_ACCESS',
      resourceType: 'UserStoreAccess',
      resourceId: row.id,
      userId: byUserId,
      tenantId,
      success: true,
      metadata: { targetUserId: dto.userId, storeId, accessLevel: dto.accessLevel },
    });
    return row;
  }

  async revokeAccess(
    tenantId: string,
    storeId: string,
    byUserId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.get(tenantId, storeId);
    await this.access.revoke(targetUserId, storeId, byUserId);
    await this.audit.logAction({
      action: 'REVOKE_ACCESS',
      resourceType: 'UserStoreAccess',
      resourceId: `${targetUserId}:${storeId}`,
      userId: byUserId,
      tenantId,
      success: true,
    });
  }

  async listUserStoreIds(userId: string): Promise<string[]> {
    return this.access.listActiveStoresForUser(userId);
  }
}
