import { LoggerService } from '@/logging/logger.service';

import {
  AI_CB_FAILURE_THRESHOLD,
  AI_CB_OPEN_DURATION_MS,
  AI_CB_SUCCESS_THRESHOLD,
} from '../ai.constants';
import { AiCircuitBreakerService } from '../services/ai-circuit-breaker.service';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

describe('AiCircuitBreakerService', () => {
  it('starts closed and stays closed on success', () => {
    const cb = new AiCircuitBreakerService(buildLogger());
    expect(cb.getState('openai')).toBe('closed');
    cb.recordSuccess('openai');
    expect(cb.isAllowed('openai')).toBe(true);
  });

  it('opens after the failure threshold', () => {
    const cb = new AiCircuitBreakerService(buildLogger());
    for (let i = 0; i < AI_CB_FAILURE_THRESHOLD; i += 1) cb.recordFailure('openai');
    expect(cb.getState('openai')).toBe('open');
    expect(cb.isAllowed('openai')).toBe(false);
  });

  it('isolates state per provider — opening openai does not trip claude', () => {
    const cb = new AiCircuitBreakerService(buildLogger());
    for (let i = 0; i < AI_CB_FAILURE_THRESHOLD; i += 1) cb.recordFailure('openai');
    expect(cb.getState('openai')).toBe('open');
    expect(cb.getState('claude')).toBe('closed');
    expect(cb.isAllowed('claude')).toBe(true);
  });

  it('transitions to half-open after open duration elapses', () => {
    const cb = new AiCircuitBreakerService(buildLogger());
    for (let i = 0; i < AI_CB_FAILURE_THRESHOLD; i += 1) cb.recordFailure('rekognition');
    expect(cb.isAllowed('rekognition')).toBe(false);
    expect(cb.isAllowed('rekognition', Date.now() + AI_CB_OPEN_DURATION_MS + 100)).toBe(true);
    expect(cb.getState('rekognition')).toBe('half-open');
  });

  it('closes from half-open after success threshold', () => {
    const cb = new AiCircuitBreakerService(buildLogger());
    for (let i = 0; i < AI_CB_FAILURE_THRESHOLD; i += 1) cb.recordFailure('google-vision');
    cb.isAllowed('google-vision', Date.now() + AI_CB_OPEN_DURATION_MS + 100);
    for (let i = 0; i < AI_CB_SUCCESS_THRESHOLD; i += 1) cb.recordSuccess('google-vision');
    expect(cb.getState('google-vision')).toBe('closed');
  });

  it('re-opens immediately on a failure during half-open', () => {
    const cb = new AiCircuitBreakerService(buildLogger());
    for (let i = 0; i < AI_CB_FAILURE_THRESHOLD; i += 1) cb.recordFailure('google-vision');
    cb.isAllowed('google-vision', Date.now() + AI_CB_OPEN_DURATION_MS + 100);
    cb.recordFailure('google-vision');
    expect(cb.getState('google-vision')).toBe('open');
  });

  it('reset() clears state', () => {
    const cb = new AiCircuitBreakerService(buildLogger());
    for (let i = 0; i < AI_CB_FAILURE_THRESHOLD; i += 1) cb.recordFailure('openai');
    expect(cb.getState('openai')).toBe('open');
    cb.reset('openai');
    expect(cb.getState('openai')).toBe('closed');
  });
});
