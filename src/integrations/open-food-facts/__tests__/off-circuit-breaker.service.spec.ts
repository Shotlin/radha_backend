import { LoggerService } from '@/logging/logger.service';

import { OffCircuitBreakerService } from '../off-circuit-breaker.service';
import {
  OFF_CB_FAILURE_THRESHOLD,
  OFF_CB_OPEN_DURATION_MS,
  OFF_CB_SUCCESS_THRESHOLD,
} from '../off.constants';

const buildBreaker = (): OffCircuitBreakerService =>
  new OffCircuitBreakerService({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService);

describe('OffCircuitBreakerService', () => {
  it('starts closed and stays closed on success', () => {
    const cb = buildBreaker();
    expect(cb.getState()).toBe('closed');
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
    expect(cb.isAllowed()).toBe(true);
  });

  it('opens after FAILURE_THRESHOLD failures', () => {
    const cb = buildBreaker();
    for (let i = 0; i < OFF_CB_FAILURE_THRESHOLD; i += 1) cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.isAllowed()).toBe(false);
  });

  it('transitions to half-open after open duration elapses', () => {
    const cb = buildBreaker();
    for (let i = 0; i < OFF_CB_FAILURE_THRESHOLD; i += 1) cb.recordFailure();
    expect(cb.isAllowed()).toBe(false);
    expect(cb.isAllowed(Date.now() + OFF_CB_OPEN_DURATION_MS + 100)).toBe(true);
    expect(cb.getState()).toBe('half-open');
  });

  it('closes from half-open after SUCCESS_THRESHOLD successes', () => {
    const cb = buildBreaker();
    for (let i = 0; i < OFF_CB_FAILURE_THRESHOLD; i += 1) cb.recordFailure();
    cb.isAllowed(Date.now() + OFF_CB_OPEN_DURATION_MS + 100); // → half-open
    for (let i = 0; i < OFF_CB_SUCCESS_THRESHOLD; i += 1) cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('re-opens immediately on a failure during half-open', () => {
    const cb = buildBreaker();
    for (let i = 0; i < OFF_CB_FAILURE_THRESHOLD; i += 1) cb.recordFailure();
    cb.isAllowed(Date.now() + OFF_CB_OPEN_DURATION_MS + 100);
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });
});
