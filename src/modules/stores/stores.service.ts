import { Injectable } from '@nestjs/common';

import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditLogService } from '@/observability/audit-log.service';
import { UsersRepository } from '@/modules/auth/repositories/users.repository';
import type { UserRole } from '@/shared-types';

import { TenantsRepository } from '../tenants/repositories/tenants.repository';
import { CreateStoreDto, GrantStoreAccessDto, UpdateStoreDto } from '../tenants/dto/onboard-tenant.dto';
import { StoresRepository } from './repositories/stores.repository';
import { UserStoreAccessRepository } from './repositories/user-store-access.repository';
import { generateStoreCode } from './utils/store-code.util';
import type { StoreRow, UserStoreAccessRow } from '@/db/schema/tenants';

const MAX_SHORT_CODE_ATTEMPTS = 5;

/** Staff-invite role -> store-level access grant. See GrantStoreAccessSchema's doc comment. */
const ROLE_TO_ACCESS_LEVEL: Record<'manager' | 'staff' | 'auditor', 'read' | 'write' | 'admin'> = {
  manager: 'admin',
  staff: 'write',
  auditor: 'read',
};

export interface UserLookupResult {
  exists: boolean;
  userId?: string;
  displayName?: string;
  /** True when this user already has active access to the target store. */
  alreadyMember?: boolean;
}

export interface StoreStaffMember {
  userId: string;
  name: string | null;
  email: string | null;
  mobile: string | null;
  role: UserRole;
  accessLevel: 'read' | 'write' | 'admin';
  grantedAt: Date | null;
}

@Injectable()
export class StoresService {
  constructor(
    private readonly stores: StoresRepository,
    private readonly access: UserStoreAccessRepository,
    private readonly tenants: TenantsRepository,
    private readonly users: UsersRepository,
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

  /** Store Details screen (name, address, GSTIN, business hours) — owner-only, see StoresController. */
  async update(
    tenantId: string,
    storeId: string,
    byUserId: string,
    dto: UpdateStoreDto,
  ): Promise<StoreRow> {
    await this.get(tenantId, storeId); // ensures the store exists in this tenant
    const updated = await this.stores.update(storeId, {
      name: dto.name,
      addressLine1: dto.addressLine1,
      city: dto.city,
      state: dto.state,
      pincode: dto.pincode,
      gstin: dto.gstin ?? null,
      // Only touch this column when the caller actually sent hours —
      // omitting the key (rather than setting it to `undefined`) keeps a
      // previously-saved schedule intact on a save that doesn't include it.
      ...(dto.businessHours !== undefined ? { businessHours: dto.businessHours } : {}),
    });
    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'Store',
      resourceId: storeId,
      userId: byUserId,
      tenantId,
      success: true,
    });
    return updated;
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
      shortCode: await this.ensureShortCode(),
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

  /** Generates a short store code, re-rolling on the rare pre-insert collision. */
  private async ensureShortCode(): Promise<string> {
    for (let attempt = 0; attempt < MAX_SHORT_CODE_ATTEMPTS; attempt += 1) {
      const candidate = generateStoreCode();
      const collision = await this.stores.findByShortCode(candidate);
      if (!collision) return candidate;
    }
    throw new Error(`Failed to generate a unique store code after ${MAX_SHORT_CODE_ATTEMPTS} attempts`);
  }

  /**
   * Staff invite sheet's live email-verify step: does a user with this
   * email exist, and are they already on this store? `email` has no
   * unique constraint on `users` (Phase 13 — Google vs OTP accounts can
   * theoretically collide), so this takes the first match; good enough
   * for a "does this look right before I invite them" checkmark, not a
   * strict identity guarantee.
   */
  async lookupUserByEmail(
    tenantId: string,
    storeId: string,
    email: string,
  ): Promise<UserLookupResult> {
    await this.get(tenantId, storeId);
    const user = await this.users.findByEmail(email);
    if (!user) return { exists: false };
    const existingAccess = await this.access.findActive(user.id, storeId);
    return {
      exists: true,
      userId: user.id,
      displayName: user.name && user.name.length > 0 ? user.name : undefined,
      alreadyMember: existingAccess != null,
    };
  }

  /**
   * Staff invite (Staff & roles > Invite). Grants store access AND
   * assigns `role` onto the invitee's account — mirroring the
   * pre-existing mobile/OTP invite-acceptance behaviour in
   * `AuthService.resolveOrCreateUser`, which already moves an invited
   * user into the inviter's tenant with the assigned role. Without
   * this, a join-table row alone wouldn't grant the permissions that
   * role name implies, since every `@Roles()`/permission check in the
   * app reads `users.role`, not `userStoreAccess.accessLevel`.
   */
  async grantAccess(
    tenantId: string,
    storeId: string,
    byUserId: string,
    dto: GrantStoreAccessDto,
  ): Promise<UserStoreAccessRow> {
    await this.get(tenantId, storeId); // ensures store exists in tenant

    const targetUser = await this.users.findById(dto.userId);
    if (!targetUser) throw new DomainNotFoundException('User', dto.userId);
    if (targetUser.tenantId !== tenantId || targetUser.role !== (dto.role as UserRole)) {
      await this.users.update(dto.userId, { tenantId, role: dto.role });
    }

    const accessLevel = ROLE_TO_ACCESS_LEVEL[dto.role];
    const existing = await this.access.findActive(dto.userId, storeId);
    if (existing) {
      // Re-inviting an existing member (e.g. changing their role) —
      // upgrade the access-level column in place instead of silently
      // leaving it stale relative to the just-updated `users.role`.
      return existing.accessLevel === accessLevel
        ? existing
        : this.access.update(existing.id, { accessLevel });
    }
    const row = await this.access.create({
      userId: dto.userId,
      storeId,
      accessLevel,
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
      metadata: { targetUserId: dto.userId, storeId, role: dto.role, accessLevel },
    });
    return row;
  }

  /**
   * Staff & roles screen's team list, and the Create Task assignee
   * picker. No list endpoint existed before this — `grantAccess`
   * (write) and `revokeAccess` (write) were the only `/access` routes.
   * `UserStoreAccessRepository.listActiveUsersForStore` returns raw
   * join-table rows with no user identity, so this batch-fetches each
   * member's name/email/mobile/role to join client-side (staff counts
   * are small — free tier caps at 5 — so N+1 here is fine).
   */
  async listStaff(tenantId: string, storeId: string): Promise<StoreStaffMember[]> {
    await this.get(tenantId, storeId);
    const rows = await this.access.listActiveUsersForStore(storeId);
    const members = await Promise.all(
      rows.map(async (row) => {
        const user = await this.users.findById(row.userId);
        if (!user || user.tenantId !== tenantId) return null;
        return {
          userId: user.id,
          name: user.name,
          email: user.email,
          mobile: user.mobile,
          role: user.role,
          accessLevel: row.accessLevel,
          grantedAt: row.grantedAt,
        };
      }),
    );
    return members.filter((m): m is StoreStaffMember => m !== null);
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
