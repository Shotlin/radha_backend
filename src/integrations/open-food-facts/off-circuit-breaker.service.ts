import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import {
  OFF_CB_FAILURE_THRESHOLD,
  OFF_CB_OPEN_DURATION_MS,
  OFF_CB_SUCCESS_THRESHOLD,
} from './off.constants';
import type { CircuitState } from './off.types';

/**
 * Three-state circuit breaker for the OFF API.
 *
 *   `closed`    — every request goes through.
 *   `open`      — every request short-circuits (`isAllowed` ⇒ false)
 *                 until OFF_CB_OPEN_DURATION_MS elapses.
 *   `half-open` — single probe permitted; success closes the circuit,
 *                 failure re-opens it.
 *
 * Critical side effect: prevents the OFF outage from cascading into
 * a backed-up request queue and timeouts on every Mobile_App scan.
 */
@Injectable()
export class OffCircuitBreakerService {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private nextAttemptAt: number | null = null;

  constructor(private readonly logger: LoggerService) {}

  isAllowed(now: number = Date.now()): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.nextAttemptAt !== null && now >= this.nextAttemptAt) {
        this.transition('half-open');
        return true;
      }
      return false;
    }
    return true; // half-open: allow probe
  }

  recordSuccess(): void {
    this.failureCount = 0;
    if (this.state === 'half-open') {
      this.successCount += 1;
      if (this.successCount >= OFF_CB_SUCCESS_THRESHOLD) {
        this.transition('closed');
      }
    }
  }

  recordFailure(): void {
    this.successCount = 0;
    this.failureCount += 1;
    if (this.state === 'half-open') {
      this.transition('open');
    } else if (this.failureCount >= OFF_CB_FAILURE_THRESHOLD) {
      this.transition('open');
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  /** Test helper. */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttemptAt = null;
  }

  private transition(next: CircuitState): void {
    this.logger.warn('off.circuit.transition', {
      from: this.state,
      to: next,
      failureCount: this.failureCount,
      successCount: this.successCount,
    });
    this.state = next;
    if (next === 'open') {
      this.nextAttemptAt = Date.now() + OFF_CB_OPEN_DURATION_MS;
      this.successCount = 0;
    } else if (next === 'closed') {
      this.failureCount = 0;
      this.successCount = 0;
      this.nextAttemptAt = null;
    }
  }
}
