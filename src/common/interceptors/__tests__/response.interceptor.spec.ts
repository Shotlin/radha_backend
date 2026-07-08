import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import { RequestContextService } from '@/common/context/request-context.service';

import { ResponseInterceptor, SKIP_RESPONSE_ENVELOPE } from '../response.interceptor';

describe('ResponseInterceptor', () => {
  const ctx: jest.Mocked<RequestContextService> = {
    getRequestId: jest.fn(() => 'req-1'),
    getDuration: jest.fn(() => 12),
  } as unknown as jest.Mocked<RequestContextService>;

  const buildExecCtx = (): ExecutionContext =>
    ({
      getHandler: () => () => undefined,
      getClass: () => class {},
    }) as unknown as ExecutionContext;

  const next = (data: unknown): CallHandler => ({ handle: () => of(data) });

  it('wraps handler return value in standard envelope', async () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const interceptor = new ResponseInterceptor(ctx, reflector);
    const out = await firstValueFrom(interceptor.intercept(buildExecCtx(), next({ ok: true })));
    expect(out).toEqual({
      success: true,
      data: { ok: true },
      meta: {
        requestId: 'req-1',
        timestamp: expect.any(String),
        durationMs: 12,
      },
    });
  });

  it('skips wrapping when SKIP_RESPONSE_ENVELOPE metadata is set', async () => {
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key) => (key === SKIP_RESPONSE_ENVELOPE ? true : undefined));
    const interceptor = new ResponseInterceptor(ctx, reflector);
    const out = await firstValueFrom(interceptor.intercept(buildExecCtx(), next('raw')));
    expect(out).toBe('raw');
  });
});
