import { Test } from '@nestjs/testing';

import { LoggerService } from '@/logging/logger.service';

import { MetricsService } from '../metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;
  let logger: { info: jest.Mock };

  beforeEach(async () => {
    logger = { info: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [MetricsService, { provide: LoggerService, useValue: logger }],
    }).compile();
    service = moduleRef.get(MetricsService);
  });

  it('counter() emits a counter metric with the provided value', () => {
    service.counter('scans.processed', 3, { tenant: 't1' });
    expect(logger.info).toHaveBeenCalledWith(
      'metric',
      expect.objectContaining({
        metric: true,
        kind: 'counter',
        name: 'scans.processed',
        value: 3,
        labels: { tenant: 't1' },
      }),
    );
  });

  it('gauge() emits a gauge metric', () => {
    service.gauge('queue.depth', 42);
    expect(logger.info).toHaveBeenCalledWith(
      'metric',
      expect.objectContaining({ kind: 'gauge', name: 'queue.depth', value: 42 }),
    );
  });

  it('histogram() emits a histogram metric', () => {
    service.histogram('http.latency_ms', 187);
    expect(logger.info).toHaveBeenCalledWith(
      'metric',
      expect.objectContaining({ kind: 'histogram', name: 'http.latency_ms', value: 187 }),
    );
  });
});
