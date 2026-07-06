import { LoggerService } from '@/logging/logger.service';

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Generic three-state circuit breaker, extracted from
 * `OffCircuitBreakerService` so the new Open Beauty Facts / Open
 * Products Facts / UPCitemdb providers each get their OWN isolated
 * instance (one provider's outage must not trip another's breaker)
 * without copy-pasting the state machine three times.
 *
 * Not a Nest `@Injectable()` — each provider service constructs its
 * own instance directly (`new CircuitBreakerService(logger, 'open_beauty_facts')`)
 * since the only dependency is the logger the service already has.
 * `OffCircuitBreakerService` itself is untouched; this does not
 * replace it, only the new providers added alongside it use this one.
 */
export class CircuitBreakerService {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private nextAttemptAt: number | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly providerName: string,
    private readonly failureThreshold = 5,
    private readonly successThreshold = 2,
    private readonly openDurationMs = 60_000,
  ) {}

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
      if (this.successCount >= this.successThreshold) {
        this.transition('closed');
      }
    }
  }

  recordFailure(): void {
    this.successCount = 0;
    this.failureCount += 1;
    if (this.state === 'half-open') {
      this.transition('open');
    } else if (this.failureCount >= this.failureThreshold) {
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
    this.logger.warn('product_provider.circuit.transition', {
      provider: this.providerName,
      from: this.state,
      to: next,
      failureCount: this.failureCount,
      successCount: this.successCount,
    });
    this.state = next;
    if (next === 'open') {
      this.nextAttemptAt = Date.now() + this.openDurationMs;
      this.successCount = 0;
    } else if (next === 'closed') {
      this.failureCount = 0;
      this.successCount = 0;
      this.nextAttemptAt = null;
    }
  }
}
