import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricEvent {
  name: string;
  kind: MetricKind;
  value: number;
  labels?: Record<string, string>;
  timestamp?: number;
}

/**
 * Lightweight metrics emitter.
 *
 * In BE-04 we just structure-log every metric. BE-48 (Observability)
 * swaps the implementation for an OpenTelemetry exporter without
 * touching call sites because consumers depend on this service's
 * shape, not on a specific backend.
 */
@Injectable()
export class MetricsService {
  constructor(private readonly logger: LoggerService) {}

  counter(name: string, value = 1, labels?: Record<string, string>): void {
    this.emit({ name, kind: 'counter', value, labels });
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    this.emit({ name, kind: 'gauge', value, labels });
  }

  histogram(name: string, value: number, labels?: Record<string, string>): void {
    this.emit({ name, kind: 'histogram', value, labels });
  }

  private emit(event: MetricEvent): void {
    this.logger.info('metric', {
      metric: true,
      ...event,
      timestamp: event.timestamp ?? Date.now(),
    });
  }
}
