import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import {
  AI_CB_FAILURE_THRESHOLD,
  AI_CB_OPEN_DURATION_MS,
  AI_CB_SUCCESS_THRESHOLD,
} from '../ai.constants';
import type { AiProvider } from '../types/ai.types';

type CircuitState = 'closed' | 'open' | 'half-open';

interface PerProviderState {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  nextAttemptAt: number | null;
}

/**
 * BE-22 — Per-provider circuit breaker for paid AI integrations.
 *
 * Mirrors `OffCircuitBreakerService` (BE-11) but indexes state by
 * provider so an OpenAI outage doesn't trip Google Vision and vice
 * versa. State is in-process; in the worker process we rely on each
 * pod tracking its own counters since traffic is small relative to
 * the breakers' window.
 *
 * Why per-provider? The orchestrator can fall back from OpenAI to
 * Claude to mock when one provider's circuit is open. With a single
 * shared breaker, a Claude outage would erroneously block OpenAI.
 */
@Injectable()
export class AiCircuitBreakerService {
  private readonly states = new Map<AiProvider, PerProviderState>();

  constructor(private readonly logger: LoggerService) {}

  isAllowed(provider: AiProvider, now: number = Date.now()): boolean {
    const s = this.getOrCreate(provider);
    if (s.state === 'closed') return true;
    if (s.state === 'open') {
      if (s.nextAttemptAt !== null && now >= s.nextAttemptAt) {
        this.transition(provider, 'half-open');
        return true;
      }
      return false;
    }
    return true; // half-open: allow probe
  }

  recordSuccess(provider: AiProvider): void {
    const s = this.getOrCreate(provider);
    s.failureCount = 0;
    if (s.state === 'half-open') {
      s.successCount += 1;
      if (s.successCount >= AI_CB_SUCCESS_THRESHOLD) {
        this.transition(provider, 'closed');
      }
    }
  }

  recordFailure(provider: AiProvider): void {
    const s = this.getOrCreate(provider);
    s.successCount = 0;
    s.failureCount += 1;
    if (s.state === 'half-open') {
      this.transition(provider, 'open');
    } else if (s.failureCount >= AI_CB_FAILURE_THRESHOLD) {
      this.transition(provider, 'open');
    }
  }

  getState(provider: AiProvider): CircuitState {
    return this.getOrCreate(provider).state;
  }

  /** Test helper. */
  reset(provider?: AiProvider): void {
    if (provider) {
      this.states.delete(provider);
    } else {
      this.states.clear();
    }
  }

  private getOrCreate(provider: AiProvider): PerProviderState {
    let s = this.states.get(provider);
    if (!s) {
      s = { state: 'closed', failureCount: 0, successCount: 0, nextAttemptAt: null };
      this.states.set(provider, s);
    }
    return s;
  }

  private transition(provider: AiProvider, next: CircuitState): void {
    const s = this.getOrCreate(provider);
    this.logger.warn('ai.circuit.transition', {
      provider,
      from: s.state,
      to: next,
      failureCount: s.failureCount,
      successCount: s.successCount,
    });
    s.state = next;
    if (next === 'open') {
      s.nextAttemptAt = Date.now() + AI_CB_OPEN_DURATION_MS;
      s.successCount = 0;
    } else if (next === 'closed') {
      s.failureCount = 0;
      s.successCount = 0;
      s.nextAttemptAt = null;
    }
  }
}
