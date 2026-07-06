import type { ExportRequest, ExportResult } from './export.types';

/**
 * BE-20 ↔ BE-21 boundary type.
 *
 * `ReportQueueService` only needs `exportData(request, userId)`. By
 * pinning that to a small interface we keep the queue independent of
 * the BE-21 implementation, which makes both phases easier to unit-
 * test in isolation. The DI token here is the only public surface.
 */

export const EXPORT_SERVICE = Symbol('REPORTS_EXPORT_SERVICE');

export interface IExportFacade {
  exportData(request: ExportRequest, userId: string): Promise<ExportResult>;
}
