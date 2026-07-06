import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { IRequestContext, IRequestContextService } from './request-context.types';

/**
 * Thin façade over `nestjs-cls`'s `ClsService`.
 *
 * Centralises the keys we put into the request store so that consumers
 * never have to remember magic strings, and so adding a new field is a
 * one-place change.
 */
@Injectable()
export class RequestContextService implements IRequestContextService {
  constructor(private readonly cls: ClsService) {}

  set<K extends keyof IRequestContext>(key: K, value: IRequestContext[K]): void {
    this.cls.set(key as string, value);
  }

  get<K extends keyof IRequestContext>(key: K): IRequestContext[K] | undefined {
    return this.cls.get(key as string) as IRequestContext[K] | undefined;
  }

  getAll(): IRequestContext {
    return {
      requestId: this.getRequestId(),
      startTime: this.cls.get<number>('startTime') ?? Date.now(),
      userAgent: this.cls.get<string>('userAgent'),
      ipAddress: this.cls.get<string>('ipAddress'),
      userId: this.cls.get<string>('userId'),
      tenantId: this.cls.get<string>('tenantId'),
      storeId: this.cls.get<string>('storeId'),
      role: this.cls.get('role'),
      correlationId: this.cls.get<string>('correlationId'),
      idempotencyKey: this.cls.get<string>('idempotencyKey'),
    };
  }

  getRequestId(): string {
    return this.cls.get<string>('requestId') ?? 'unknown';
  }

  getUserId(): string | undefined {
    return this.cls.get<string>('userId');
  }

  getTenantId(): string | undefined {
    return this.cls.get<string>('tenantId');
  }

  getDuration(): number {
    const startTime = this.cls.get<number>('startTime') ?? Date.now();
    return Date.now() - startTime;
  }
}
