import { DatabaseHealthIndicator } from '../health/database.health-indicator';

describe('DatabaseHealthIndicator', () => {
  it('returns ok when ping resolves true', async () => {
    const db = { ping: jest.fn().mockResolvedValue(true) };
    const indicator = new DatabaseHealthIndicator(
      db as unknown as ConstructorParameters<typeof DatabaseHealthIndicator>[0],
    );
    const result = await indicator.check();
    expect(result.status).toBe('ok');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('returns down when ping resolves false', async () => {
    const db = { ping: jest.fn().mockResolvedValue(false) };
    const indicator = new DatabaseHealthIndicator(
      db as unknown as ConstructorParameters<typeof DatabaseHealthIndicator>[0],
    );
    expect((await indicator.check()).status).toBe('down');
  });

  it('returns down with error when ping throws', async () => {
    const db = { ping: jest.fn().mockRejectedValue(new Error('boom')) };
    const indicator = new DatabaseHealthIndicator(
      db as unknown as ConstructorParameters<typeof DatabaseHealthIndicator>[0],
    );
    const result = await indicator.check();
    expect(result.status).toBe('down');
    expect(result.error).toBe('boom');
  });
});
