import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import type { AllergenProfileRow } from '@/db/schema/allergen-profiles';

import type { UpsertAllergenProfileDto } from '../dto/upsert-allergen-profile.dto';
import { AllergenProfileRepository } from '../repositories/allergen-profile.repository';
import { AllergenMatcherService, AllergenMatch } from './allergen-matcher.service';
import { AllergenEncryptionService } from './encryption.service';

/**
 * BE-37 — Allergen profile service.
 *
 * Business logic:
 *   - Quota enforcement: Free = 1 profile, Premium = 5.
 *   - Encryption of display names at rest.
 *   - Allergen matching delegation to AllergenMatcherService.
 */

/** Quota limits by subscription tier. */
const QUOTA_MAP: Record<string, number> = {
  free_consumer: 1,
  free: 1,
  starter: 1,
  trial_pro: 5,
  growth: 5,
  pro: 5,
  premium_consumer: 5,
  premium: 5,
};

export interface AllergenProfileResponse {
  id: string;
  tenantId: string;
  userId: string;
  familyMemberUserId: string | null;
  displayName: string;
  ageBand: string;
  allergyTags: string[];
  conditionTags: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class AllergenProfileService {
  private readonly logger = new Logger(AllergenProfileService.name);

  constructor(
    private readonly repo: AllergenProfileRepository,
    private readonly encryption: AllergenEncryptionService,
    private readonly matcher: AllergenMatcherService,
  ) {}

  /**
   * Create or update an allergen profile.
   * Enforces plan-based quota on create.
   */
  async upsert(
    tenantId: string,
    userId: string,
    dto: UpsertAllergenProfileDto,
    planCode: string = 'free',
  ): Promise<AllergenProfileResponse> {
    if (dto.id) {
      return this.update(tenantId, userId, dto.id, dto);
    }
    return this.create(tenantId, userId, dto, planCode);
  }

  private async create(
    tenantId: string,
    userId: string,
    dto: UpsertAllergenProfileDto,
    planCode: string,
  ): Promise<AllergenProfileResponse> {
    const maxProfiles = this.getMaxProfiles(planCode);
    const existing = await this.repo.countByUser(tenantId, userId);

    if (existing >= maxProfiles) {
      throw new ConflictException(
        `Maximum ${maxProfiles} allergen profile(s) allowed for your plan. Upgrade to add more.`,
      );
    }

    const displayNameEncrypted = this.encryption.encrypt(dto.displayName);

    const row = await this.repo.create({
      tenantId,
      userId,
      familyMemberUserId: dto.familyMemberUserId ?? null,
      displayNameEncrypted,
      ageBand: dto.ageBand,
      allergyTags: dto.allergyTags,
      conditionTags: dto.conditionTags,
      isActive: existing === 0, // first profile is automatically active
    });

    this.logger.log(`Allergen profile created: ${row.id} for user ${userId}`);
    return this.toResponse(row);
  }

  private async update(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpsertAllergenProfileDto,
  ): Promise<AllergenProfileResponse> {
    const existing = await this.repo.findById(id, tenantId);
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException('Allergen profile not found');
    }

    const displayNameEncrypted = this.encryption.encrypt(dto.displayName);

    const row = await this.repo.update(id, tenantId, {
      familyMemberUserId: dto.familyMemberUserId ?? null,
      displayNameEncrypted,
      ageBand: dto.ageBand,
      allergyTags: dto.allergyTags,
      conditionTags: dto.conditionTags,
    });

    if (!row) {
      throw new NotFoundException('Allergen profile not found');
    }

    this.logger.log(`Allergen profile updated: ${id}`);
    return this.toResponse(row);
  }

  /**
   * List all profiles for a user (with decrypted display names).
   */
  async listByUser(tenantId: string, userId: string): Promise<AllergenProfileResponse[]> {
    const rows = await this.repo.findByUser(tenantId, userId);
    return rows.map((row) => this.toResponse(row));
  }

  /**
   * Soft-delete a profile.
   */
  async delete(tenantId: string, userId: string, id: string): Promise<{ success: boolean }> {
    const existing = await this.repo.findById(id, tenantId);
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException('Allergen profile not found');
    }

    await this.repo.softDelete(id, tenantId);
    this.logger.log(`Allergen profile soft-deleted: ${id}`);
    return { success: true };
  }

  /**
   * Set a profile as the active one for scans.
   */
  async setActive(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<AllergenProfileResponse> {
    const existing = await this.repo.findById(id, tenantId);
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException('Allergen profile not found');
    }

    const row = await this.repo.setActive(id, tenantId, userId);
    if (!row) {
      throw new NotFoundException('Allergen profile not found');
    }

    this.logger.log(`Allergen profile set active: ${id} for user ${userId}`);
    return this.toResponse(row);
  }

  /**
   * Match a profile's allergens against product ingredients.
   * Used by BE-12 comprehensive scoring.
   */
  async matchAllergens(
    tenantId: string,
    profileId: string,
    ingredients: string[],
    productAllergens: string[],
  ): Promise<AllergenMatch[]> {
    const profile = await this.repo.findById(profileId, tenantId);
    if (!profile) {
      throw new NotFoundException('Allergen profile not found');
    }
    return this.matcher.match(profile, ingredients, productAllergens);
  }

  /**
   * Get the maximum number of profiles allowed for a plan.
   */
  getMaxProfiles(planCode: string): number {
    return QUOTA_MAP[planCode.toLowerCase()] ?? 1;
  }

  private toResponse(row: AllergenProfileRow): AllergenProfileResponse {
    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      familyMemberUserId: row.familyMemberUserId,
      displayName: this.encryption.decrypt(row.displayNameEncrypted),
      ageBand: row.ageBand,
      allergyTags: row.allergyTags ?? [],
      conditionTags: row.conditionTags ?? [],
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
