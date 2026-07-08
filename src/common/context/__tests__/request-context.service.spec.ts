import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';

import { RequestContextService } from '../request-context.service';

describe('RequestContextService', () => {
  let service: RequestContextService;
  let cls: ClsService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot()],
      providers: [RequestContextService],
    }).compile();

    service = moduleRef.get(RequestContextService);
    cls = moduleRef.get(ClsService);
  });

  it('returns "unknown" when no request id is set', async () => {
    await cls.run({}, () => {
      expect(service.getRequestId()).toBe('unknown');
    });
  });

  it('round-trips set/get inside the same CLS context', async () => {
    await cls.run({}, () => {
      service.set('requestId', 'req-1');
      service.set('userId', 'user-42');
      service.set('tenantId', 'tenant-9');
      expect(service.getRequestId()).toBe('req-1');
      expect(service.getUserId()).toBe('user-42');
      expect(service.getTenantId()).toBe('tenant-9');
    });
  });

  it('isolates context between two concurrent requests', async () => {
    const p1 = cls.run({}, async () => {
      service.set('requestId', 'r-1');
      await new Promise((r) => setTimeout(r, 5));
      return service.getRequestId();
    });
    const p2 = cls.run({}, async () => {
      service.set('requestId', 'r-2');
      await new Promise((r) => setTimeout(r, 5));
      return service.getRequestId();
    });
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe('r-1');
    expect(b).toBe('r-2');
  });

  it('returns a snapshot via getAll()', async () => {
    await cls.run({}, () => {
      service.set('requestId', 'r');
      service.set('userId', 'u');
      service.set('tenantId', 't');
      service.set('startTime', 1000);
      const snap = service.getAll();
      expect(snap).toMatchObject({
        requestId: 'r',
        userId: 'u',
        tenantId: 't',
        startTime: 1000,
      });
    });
  });

  it('computes elapsed duration from startTime', async () => {
    await cls.run({}, () => {
      service.set('startTime', Date.now() - 50);
      const dur = service.getDuration();
      expect(dur).toBeGreaterThanOrEqual(50);
      expect(dur).toBeLessThan(500);
    });
  });
});
