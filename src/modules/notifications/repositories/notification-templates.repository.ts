import { Injectable } from '@nestjs/common';
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  NewNotificationTemplate,
  NotificationTemplateRow,
  notificationTemplates,
} from '@/db/schema/notifications';

/**
 * BE-24 — `notification_templates` table.
 *
 * Resolution order in `findEffective`:
 *   1. Active row matching (tenantId, key, locale)
 *   2. Active platform default row (tenantId IS NULL, key, locale)
 *   3. null — caller falls back to the in-process default registry.
 */
@Injectable()
export class NotificationTemplatesRepository extends BaseRepository<
  typeof notificationTemplates,
  NotificationTemplateRow,
  NewNotificationTemplate,
  Partial<NewNotificationTemplate>
> {
  constructor(db: DbService) {
    super(db.getDb(), notificationTemplates, 'notification_templates');
  }

  async findEffective(
    key: string,
    tenantId: string | null,
    locale = 'en',
  ): Promise<NotificationTemplateRow | null> {
    // Tenant override first.
    if (tenantId) {
      const [tenantRow] = await this.db
        .select()
        .from(notificationTemplates)
        .where(
          and(
            eq(notificationTemplates.tenantId, tenantId),
            eq(notificationTemplates.key, key),
            eq(notificationTemplates.locale, locale),
            eq(notificationTemplates.isActive, true),
            isNull(notificationTemplates.deletedAt),
          ),
        )
        .limit(1);
      if (tenantRow) return tenantRow as NotificationTemplateRow;
    }

    // Platform default.
    const [globalRow] = await this.db
      .select()
      .from(notificationTemplates)
      .where(
        and(
          isNull(notificationTemplates.tenantId),
          eq(notificationTemplates.key, key),
          eq(notificationTemplates.locale, locale),
          eq(notificationTemplates.isActive, true),
          isNull(notificationTemplates.deletedAt),
        ),
      )
      .limit(1);

    return (globalRow as NotificationTemplateRow | undefined) ?? null;
  }

  async listForTenant(tenantId: string): Promise<NotificationTemplateRow[]> {
    const tenantOrGlobal = or(
      eq(notificationTemplates.tenantId, tenantId),
      isNull(notificationTemplates.tenantId),
    ) as SQL;

    return (await this.db
      .select()
      .from(notificationTemplates)
      .where(
        and(tenantOrGlobal, isNull(notificationTemplates.deletedAt)),
      )) as NotificationTemplateRow[];
  }
}
