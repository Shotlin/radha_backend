import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';

import { RequestContextService } from '@/common/context/request-context.service';
import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';

import { AuditLogService } from '../audit-log.service';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let logger: { info: jest.Mock };
  let cls: ClsService;
  const baseConfig = {
    observability: { auditLogEnabled: true },
  } as unknown as ConfigService;

  beforeEach(async () => {
    logger = { info: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot()],
      providers: [
        AuditLogService,
        RequestContextService,
        { provide: LoggerService, useValue: logger },
        { provide: ConfigService, useValue: baseConfig },
      ],
    }).compile();

    service = moduleRef.get(AuditLogService);
    cls = moduleRef.get(ClsService);
  });

  it('emits a structured audit event with auto-enriched context', async () => {
    await cls.run({}, async () => {
      const ctx = service['context'] as RequestContextService;
      ctx.set('userId', 'u-1');
      ctx.set('tenantId', 't-1');
      ctx.set('ipAddress', '127.0.0.1');
      ctx.set('userAgent', 'jest');

      await service.logAction({
        action: 'CREATE',
        resourceType: 'Product',
        resourceId: 'p-1',
        userId: '',
        tenantId: '',
        success: true,
      });

      expect(logger.info).toHaveBeenCalledWith(
        'audit.event',
        expect.objectContaining({
          audit: true,
          action: 'CREATE',
          resourceType: 'Product',
          resourceId: 'p-1',
          userId: 'u-1',
          tenantId: 't-1',
          success: true,
          ipAddress: '127.0.0.1',
          userAgent: 'jest',
        }),
      );
    });
  });

  it('redacts secret-shaped metadata before logging', async () => {
    await cls.run({}, async () => {
      await service.logAction({
        action: 'LOGIN',
        resourceType: 'Session',
        resourceId: 's-1',
        userId: 'u',
        tenantId: 't',
        success: false,
        metadata: { password: 'p', apiKey: 'k' },
      });

      const calls = logger.info.mock.calls;
      const last = calls[calls.length - 1][1] as { metadata: Record<string, unknown> };
      expect(last.metadata.password).toBe('[REDACTED]');
      expect(last.metadata.apiKey).toBe('[REDACTED]');
    });
  });

  it('skips logging when audit log is disabled', async () => {
    (baseConfig as { observability: { auditLogEnabled: boolean } }).observability.auditLogEnabled =
      false;
    await cls.run({}, async () => {
      await service.logAction({
        action: 'READ',
        resourceType: 'Product',
        resourceId: 'p-1',
        userId: 'u',
        tenantId: 't',
        success: true,
      });
      expect(logger.info).not.toHaveBeenCalled();
    });
    (baseConfig as { observability: { auditLogEnabled: boolean } }).observability.auditLogEnabled =
      true;
  });

  it('logBatch processes every entry in order', async () => {
    await cls.run({}, async () => {
      await service.logBatch([
        {
          action: 'CREATE',
          resourceType: 'A',
          resourceId: '1',
          userId: 'u',
          tenantId: 't',
          success: true,
        },
        {
          action: 'UPDATE',
          resourceType: 'A',
          resourceId: '1',
          userId: 'u',
          tenantId: 't',
          success: true,
        },
      ]);
      expect(logger.info).toHaveBeenCalledTimes(2);
    });
  });

  it('returns an empty array from query() until BE-05 wires the table', async () => {
    expect(await service.query({})).toEqual([]);
  });
});
