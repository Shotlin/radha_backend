import { Test, TestingModule } from '@nestjs/testing';

import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  describe('liveness', () => {
    it('returns ok status with ISO timestamp', () => {
      const result = controller.liveness();
      expect(result.status).toBe('ok');
      expect(typeof result.timestamp).toBe('string');
      expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
      expect(result.service).toBe('radha-server');
      expect(typeof result.version).toBe('string');
    });

    it('produces a fresh timestamp on each call', async () => {
      const a = controller.liveness();
      await new Promise((r) => setTimeout(r, 5));
      const b = controller.liveness();
      expect(b.timestamp).not.toBe(a.timestamp);
    });
  });

  describe('readiness', () => {
    it('returns ready status with process check', async () => {
      const result = await controller.readiness();
      expect(result.status).toBe('ready');
      expect(result.checks.process).toBe('ok');
    });
  });
});
