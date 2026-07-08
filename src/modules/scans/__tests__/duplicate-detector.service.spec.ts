import type { ScanItemRow } from '@/db/schema/scans';

import { ScanItemsRepository } from '../repositories/scan-items.repository';
import { DuplicateDetectorService } from '../services/duplicate-detector.service';

describe('DuplicateDetectorService.findDuplicate', () => {
  const seed = {
    id: 'item-1',
    sessionId: 'session-1',
    ean: '8901030789885',
    batchNumber: 'B-100',
  } as unknown as ScanItemRow;

  it('forwards arguments to itemsRepo.findDuplicate including batchNumber', async () => {
    const findDuplicate = jest.fn(async () => seed);
    const repo = { findDuplicate } as unknown as ScanItemsRepository;
    const svc = new DuplicateDetectorService(repo);
    const result = await svc.findDuplicate('session-1', '8901030789885', 'B-100');
    expect(result?.id).toBe('item-1');
    expect(findDuplicate).toHaveBeenCalledWith('session-1', '8901030789885', 'B-100');
  });

  it('passes undefined for batchNumber when null is provided (no-batch match)', async () => {
    const findDuplicate = jest.fn(async () => null);
    const repo = { findDuplicate } as unknown as ScanItemsRepository;
    const svc = new DuplicateDetectorService(repo);
    await svc.findDuplicate('session-1', '8901030789885', null);
    expect(findDuplicate).toHaveBeenCalledWith('session-1', '8901030789885', undefined);
  });

  it('returns null when no duplicate exists', async () => {
    const findDuplicate = jest.fn(async () => null);
    const repo = { findDuplicate } as unknown as ScanItemsRepository;
    const svc = new DuplicateDetectorService(repo);
    expect(await svc.findDuplicate('session-1', '8901030789885')).toBeNull();
  });
});
