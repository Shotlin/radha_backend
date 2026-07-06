import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';

import {
  BusinessException,
  DomainConflictException,
  DomainNotFoundException,
  ValidationException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import type {
  NewSupplier,
  NewSupplierContact,
  SupplierContactRow,
  SupplierRow,
} from '@/db/schema/suppliers';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  type AddContactDto,
  CreateSupplierSchema,
  type CreateSupplierDto,
  GST_REGEX,
  PAN_REGEX,
} from './dto/create-supplier.dto';
import type { ListSuppliersDto } from './dto/list-suppliers.dto';
import type { UpdateSupplierDto } from './dto/update-supplier.dto';
import { SupplierContactsRepository } from './repositories/supplier-contacts.repository';
import { SuppliersRepository } from './repositories/suppliers.repository';
import { SupplierImportService } from './services/supplier-import.service';
import { SupplierPerformanceService } from './services/supplier-performance.service';
import {
  type ExportFormat,
  type ImportResult,
  type PaginatedSuppliers,
  type Supplier,
  type SupplierStatus,
  type SupplierWithDetails,
  SUPPLIER_STATUS_TRANSITIONS,
} from './types/supplier.types';

/**
 * BE-25 — Top-level supplier service.
 *
 * Owns the public surface for the controller. Coordinates the two
 * repositories, the performance service, the import service, and
 * the audit log. Responsibilities:
 *
 *   - CRUD with tenant scope and `code` / GST uniqueness
 *   - Status workflow (`pending → active → inactive`,
 *                       any → blacklisted, blacklisted → active)
 *   - Multi-contact management (add / remove / promote primary)
 *   - Performance read (delegates to SupplierPerformanceService)
 *   - Bulk import / xlsx export
 *
 * Every state-changing call writes to `audit_logs` (BE-04 service).
 */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly db: DbService,
    private readonly suppliersRepo: SuppliersRepository,
    private readonly contactsRepo: SupplierContactsRepository,
    private readonly performance: SupplierPerformanceService,
    private readonly importer: SupplierImportService,
    private readonly audit: AuditLogService,
    private readonly logger: LoggerService,
  ) {}

  /* ─────────────────── CRUD ─────────────────── */

  async create(tenantId: string, actorId: string, dto: CreateSupplierDto): Promise<Supplier> {
    // Validate the dto via the same schema in case the controller
    // bypassed the Zod pipe (defensive — keeps the service usable
    // from worker contexts).
    const parsed = CreateSupplierSchema.safeParse(dto);
    if (!parsed.success) {
      throw new ValidationException('Invalid supplier payload', {
        metadata: { issues: parsed.error.issues },
      });
    }
    const data = parsed.data;

    const code = data.code ?? (await this.generateUniqueCode(tenantId, data.name));

    // Code uniqueness within tenant ----------------------------------
    const codeClash = await this.suppliersRepo.findByCodeInTenant(code, tenantId);
    if (codeClash) {
      throw new DomainConflictException(
        `Supplier code "${code}" already exists`,
        ErrorCode.DUPLICATE_RESOURCE,
        { field: 'code', value: code },
      );
    }

    // GST uniqueness within tenant -----------------------------------
    if (data.gstNumber) {
      const gstClash = await this.suppliersRepo.findByGstInTenant(data.gstNumber, tenantId);
      if (gstClash) {
        throw new DomainConflictException(
          `Another supplier in this tenant already uses GST "${data.gstNumber}"`,
          ErrorCode.DUPLICATE_RESOURCE,
          { field: 'gstNumber', value: data.gstNumber },
        );
      }
    }

    return this.db.transaction(async (tx) => {
      const newRow: NewSupplier = {
        tenantId,
        name: data.name,
        legalName: data.legalName,
        code,
        gstNumber: data.gstNumber,
        panNumber: data.panNumber,
        category: data.category,
        description: data.description,
        status: 'active',
        email: data.email,
        phone: data.phone,
        alternatePhone: data.alternatePhone,
        whatsappNumber: data.whatsappNumber,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        city: data.city,
        state: data.state,
        pincode: data.pincode,
        country: data.country,
        paymentTerms: data.paymentTerms,
        deliveryDays: data.deliveryDays,
        minimumOrderAmount: data.minimumOrderAmount?.toFixed(2),
        metadata: data.metadata ?? {},
        createdBy: actorId,
      };

      const [created] = await this.suppliersRepo.bulkCreate([newRow], tx);

      // Bootstrap initial contacts if supplied
      if (data.contacts && data.contacts.length > 0) {
        let primaryAssigned = false;
        const contactRows: NewSupplierContact[] = data.contacts.map((c) => {
          const isPrimary = !primaryAssigned && c.isPrimary;
          if (isPrimary) primaryAssigned = true;
          return {
            supplierId: created.id,
            tenantId,
            name: c.name,
            designation: c.designation,
            email: c.email,
            phone: c.phone,
            isPrimary,
            notes: c.notes,
          };
        });
        await this.contactsRepo.bulkCreate(contactRows, tx);
      }

      await this.audit.logAction({
        action: 'CREATE',
        resourceType: 'Supplier',
        resourceId: created.id,
        userId: actorId,
        tenantId,
        success: true,
        metadata: { code, name: data.name },
      });

      return created;
    });
  }

  async findById(tenantId: string, id: string): Promise<SupplierWithDetails> {
    const supplier = await this.suppliersRepo.findByIdInTenant(id, tenantId);
    if (!supplier) throw new DomainNotFoundException('Supplier', id);
    const [contacts, performance] = await Promise.all([
      this.contactsRepo.listForSupplier(id),
      this.performance.getPerformance(tenantId, id),
    ]);
    return { ...supplier, contacts, performance };
  }

  async list(tenantId: string, query: ListSuppliersDto): Promise<PaginatedSuppliers> {
    return this.suppliersRepo.listPaginated({
      tenantId,
      q: query.q,
      status: query.status,
      category: query.category,
      city: query.city,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  async update(
    tenantId: string,
    actorId: string,
    id: string,
    dto: UpdateSupplierDto,
  ): Promise<Supplier> {
    const existing = await this.suppliersRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('Supplier', id);

    // Re-validate compliance fields (in case caller bypassed Zod)
    if (dto.gstNumber && !GST_REGEX.test(dto.gstNumber)) {
      throw new ValidationException('Invalid GST number format', {
        field: 'gstNumber',
        value: dto.gstNumber,
      });
    }
    if (dto.panNumber && !PAN_REGEX.test(dto.panNumber)) {
      throw new ValidationException('Invalid PAN format', {
        field: 'panNumber',
        value: dto.panNumber,
      });
    }

    if (dto.gstNumber && dto.gstNumber !== existing.gstNumber) {
      const clash = await this.suppliersRepo.findByGstInTenant(dto.gstNumber, tenantId, id);
      if (clash) {
        throw new DomainConflictException(
          `Another supplier in this tenant already uses GST "${dto.gstNumber}"`,
          ErrorCode.DUPLICATE_RESOURCE,
          { field: 'gstNumber', value: dto.gstNumber },
        );
      }
    }

    const updated = await this.suppliersRepo.update(id, {
      ...dto,
      minimumOrderAmount:
        dto.minimumOrderAmount === null ? null : dto.minimumOrderAmount?.toFixed?.(2),
      updatedBy: actorId,
    } as Partial<NewSupplier>);

    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'Supplier',
      resourceId: id,
      userId: actorId,
      tenantId,
      success: true,
      metadata: { fields: Object.keys(dto) },
    });

    return updated;
  }

  async softDelete(tenantId: string, actorId: string, id: string): Promise<void> {
    const existing = await this.suppliersRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('Supplier', id);

    await this.suppliersRepo.softDelete(id, actorId);

    await this.audit.logAction({
      action: 'DELETE',
      resourceType: 'Supplier',
      resourceId: id,
      userId: actorId,
      tenantId,
      success: true,
      metadata: { code: existing.code },
    });
  }

  /* ─────────────────── Status workflow ─────────────────── */

  async activate(tenantId: string, actorId: string, id: string): Promise<Supplier> {
    return this.transitionStatus(tenantId, actorId, id, 'active');
  }

  async deactivate(tenantId: string, actorId: string, id: string): Promise<Supplier> {
    return this.transitionStatus(tenantId, actorId, id, 'inactive');
  }

  async blacklist(
    tenantId: string,
    actorId: string,
    id: string,
    reason: string,
  ): Promise<Supplier> {
    const existing = await this.suppliersRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('Supplier', id);
    this.assertTransition(existing.status, 'blacklisted');

    const updated = await this.suppliersRepo.update(id, {
      status: 'blacklisted',
      blacklistReason: reason,
      blacklistedAt: new Date(),
      updatedBy: actorId,
    });

    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'Supplier',
      resourceId: id,
      userId: actorId,
      tenantId,
      success: true,
      metadata: { transition: 'blacklist', reason },
    });

    return updated;
  }

  /* ─────────────────── Contacts ─────────────────── */

  async addContact(
    tenantId: string,
    actorId: string,
    supplierId: string,
    dto: AddContactDto,
  ): Promise<SupplierContactRow> {
    const supplier = await this.suppliersRepo.findByIdInTenant(supplierId, tenantId);
    if (!supplier) throw new DomainNotFoundException('Supplier', supplierId);

    return this.db.transaction(async (tx) => {
      if (dto.isPrimary) {
        await this.contactsRepo.unsetPrimaryForSupplier(supplierId, undefined, tx);
      }
      const [created] = await this.contactsRepo.bulkCreate(
        [
          {
            supplierId,
            tenantId,
            name: dto.name,
            designation: dto.designation,
            email: dto.email,
            phone: dto.phone,
            isPrimary: dto.isPrimary === true,
            notes: dto.notes,
          },
        ],
        tx,
      );

      await this.audit.logAction({
        action: 'CREATE',
        resourceType: 'SupplierContact',
        resourceId: created.id,
        userId: actorId,
        tenantId,
        success: true,
        metadata: { supplierId, isPrimary: created.isPrimary },
      });

      return created;
    });
  }

  async removeContact(tenantId: string, actorId: string, contactId: string): Promise<void> {
    const contact = await this.contactsRepo.findByIdInTenant(contactId, tenantId);
    if (!contact) throw new DomainNotFoundException('SupplierContact', contactId);
    await this.contactsRepo.softDelete(contactId, actorId);

    await this.audit.logAction({
      action: 'DELETE',
      resourceType: 'SupplierContact',
      resourceId: contactId,
      userId: actorId,
      tenantId,
      success: true,
      metadata: { supplierId: contact.supplierId },
    });
  }

  async listContacts(tenantId: string, supplierId: string): Promise<SupplierContactRow[]> {
    const supplier = await this.suppliersRepo.findByIdInTenant(supplierId, tenantId);
    if (!supplier) throw new DomainNotFoundException('Supplier', supplierId);
    return this.contactsRepo.listForSupplier(supplierId);
  }

  /* ─────────────────── Search / performance ─────────────────── */

  async search(tenantId: string, query: string, limit = 25): Promise<Supplier[]> {
    return this.suppliersRepo.search(tenantId, query, limit);
  }

  async getPerformance(tenantId: string, id: string) {
    return this.performance.getPerformance(tenantId, id);
  }

  /* ─────────────────── Import / export ─────────────────── */

  async bulkImport(
    tenantId: string,
    actorId: string,
    fileType: 'xlsx' | 'csv',
    buffer: Buffer,
    fileName: string,
  ): Promise<ImportResult> {
    const importId = randomUUID();
    this.logger.info('suppliers.import.start', {
      importId,
      tenantId,
      fileName,
      fileType,
      sizeBytes: buffer.length,
    });

    const result = await this.importer.processBuffer(tenantId, actorId, fileType, buffer);

    await this.audit.logAction({
      action: 'IMPORT',
      resourceType: 'Supplier',
      resourceId: importId,
      userId: actorId,
      tenantId,
      success: result.failed === 0,
      metadata: {
        fileName,
        totalRows: result.totalRows,
        imported: result.imported,
        skipped: result.skipped,
        failed: result.failed,
      },
    });

    return result;
  }

  async exportAll(
    tenantId: string,
    actorId: string,
    format: ExportFormat = 'xlsx',
  ): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const rows = await this.suppliersRepo.listAllForExport(tenantId);
    const xlsx = await import('xlsx').catch(() => null);
    if (!xlsx) {
      throw new BusinessException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'xlsx package not installed; cannot export',
      );
    }

    const sheetData = rows.map((r) => ({
      code: r.code,
      name: r.name,
      legal_name: r.legalName ?? '',
      status: r.status,
      gst_number: r.gstNumber ?? '',
      pan_number: r.panNumber ?? '',
      category: r.category ?? '',
      email: r.email ?? '',
      phone: r.phone ?? '',
      whatsapp: r.whatsappNumber ?? '',
      city: r.city ?? '',
      state: r.state ?? '',
      pincode: r.pincode ?? '',
      country: r.country,
      payment_terms: r.paymentTerms ?? '',
      delivery_days: r.deliveryDays ?? '',
      total_grns: r.totalGrns,
      reliability_score: r.reliabilityScore ?? '',
      quality_score: r.qualityScore ?? '',
      created_at: r.createdAt.toISOString(),
    }));

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(sheetData);
    xlsx.utils.book_append_sheet(wb, ws, 'Suppliers');

    const buffer =
      format === 'csv'
        ? Buffer.from(xlsx.utils.sheet_to_csv(ws), 'utf8')
        : (xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);

    await this.audit.logAction({
      action: 'EXPORT',
      resourceType: 'Supplier',
      resourceId: tenantId,
      userId: actorId,
      tenantId,
      success: true,
      metadata: { format, count: rows.length },
    });

    return {
      buffer,
      mimeType:
        format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: `suppliers-${new Date().toISOString().slice(0, 10)}.${format}`,
    };
  }

  /* ─────────────────── helpers ─────────────────── */

  /**
   * Find a unique code within the tenant; retry up to 5 times in
   * case the random suffix collides. Realistically this loops zero
   * times — the suffix is the last 6 digits of `Date.now()` plus a
   * random alpha pair.
   */
  private async generateUniqueCode(tenantId: string, name: string): Promise<string> {
    const prefix = name
      .replace(/[^A-Z0-9]/gi, '')
      .slice(0, 4)
      .toUpperCase()
      .padEnd(2, 'X');
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix = Date.now().toString().slice(-6);
      const random = Math.random().toString(36).slice(2, 4).toUpperCase();
      const code = `SUP-${prefix}-${suffix}${random}`;
      const existing = await this.suppliersRepo.findByCodeInTenant(code, tenantId);
      if (!existing) return code;
    }
    throw new BusinessException(
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Unable to allocate a unique supplier code; try again with explicit code',
    );
  }

  private async transitionStatus(
    tenantId: string,
    actorId: string,
    id: string,
    next: SupplierStatus,
  ): Promise<SupplierRow> {
    const existing = await this.suppliersRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('Supplier', id);
    if (existing.status === next) return existing;
    this.assertTransition(existing.status, next);

    const patch: Partial<NewSupplier> = {
      status: next,
      updatedBy: actorId,
    };
    if (next === 'active') {
      patch.blacklistReason = null;
      patch.blacklistedAt = null;
    }

    const updated = await this.suppliersRepo.update(id, patch);

    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'Supplier',
      resourceId: id,
      userId: actorId,
      tenantId,
      success: true,
      metadata: { transition: `${existing.status}→${next}` },
    });

    return updated;
  }

  private assertTransition(current: SupplierStatus, next: SupplierStatus): void {
    if (current === next) return;
    const allowed = SUPPLIER_STATUS_TRANSITIONS[current];
    if (!allowed.includes(next)) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Illegal status transition ${current} → ${next}`,
      );
    }
  }
}
