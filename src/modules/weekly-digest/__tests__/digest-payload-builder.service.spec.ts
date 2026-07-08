import { DigestPayloadBuilderService } from '../services/digest-payload-builder.service';
import type { IScansSourcePort, WeeklyScanStats } from '../ports/scans-source.port';

const buildSource = (stats: Partial<WeeklyScanStats> = {}): IScansSourcePort => ({
  getWeeklyStats: jest.fn(async () => ({
    scansCount: 0,
    highSugarCount: 0,
    recallCount: 0,
    alternativesRecommended: 0,
    topProducts: [],
    savings: 0,
    ...stats,
  })),
});

describe('DigestPayloadBuilderService', () => {
  it('calls the scans source with a 7-day half-open UTC window', async () => {
    const source = buildSource();
    const builder = new DigestPayloadBuilderService(source);
    const weekStart = new Date(Date.UTC(2025, 2, 10, 0, 0, 0)); // Mon 2025-03-10 UTC

    await builder.build('user-1', weekStart);

    expect(source.getWeeklyStats).toHaveBeenCalledTimes(1);
    const args = (source.getWeeklyStats as jest.Mock).mock.calls[0];
    expect(args[0]).toBe('user-1');
    expect(args[1]).toEqual(weekStart);
    expect((args[2] as Date).toISOString()).toBe(
      new Date(Date.UTC(2025, 2, 17, 0, 0, 0)).toISOString(),
    );
  });

  it('returns a validated payload mirroring the source stats', async () => {
    const source = buildSource({
      scansCount: 12,
      highSugarCount: 3,
      recallCount: 1,
      alternativesRecommended: 4,
      topProducts: [{ productName: 'Aata', scans: 5, ean: '8901234567890' }],
      savings: 42.5,
    });
    const builder = new DigestPayloadBuilderService(source);

    const result = await builder.build('u-1', new Date(Date.UTC(2025, 2, 10)));

    expect(result).toEqual({
      scansCount: 12,
      highSugarCount: 3,
      recallCount: 1,
      alternativesRecommended: 4,
      topProducts: [{ productName: 'Aata', scans: 5, ean: '8901234567890' }],
      savings: 42.5,
    });
  });

  it('defaults topProducts and savings when omitted by the source', async () => {
    const source: IScansSourcePort = {
      getWeeklyStats: jest.fn(async () => ({
        scansCount: 1,
        highSugarCount: 0,
        recallCount: 0,
        alternativesRecommended: 0,
        topProducts: [],
        savings: 0,
      })),
    };
    const builder = new DigestPayloadBuilderService(source);

    const result = await builder.build('u-1', new Date(Date.UTC(2025, 2, 10)));

    expect(result.topProducts).toEqual([]);
    expect(result.savings).toBe(0);
  });

  it('rejects negative counts at the Zod boundary', async () => {
    const source: IScansSourcePort = {
      getWeeklyStats: jest.fn(async () => ({
        scansCount: -1,
        highSugarCount: 0,
        recallCount: 0,
        alternativesRecommended: 0,
        topProducts: [],
        savings: 0,
      })),
    };
    const builder = new DigestPayloadBuilderService(source);

    await expect(builder.build('u-1', new Date(Date.UTC(2025, 2, 10)))).rejects.toThrow();
  });
});
