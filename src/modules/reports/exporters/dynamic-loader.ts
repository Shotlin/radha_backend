import { ExternalServiceException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

/**
 * BE-21 — Dynamic-import shim for runtime-only deps (`exceljs`,
 * `pdfkit`).
 *
 * The S3Service in BE-13 uses the same trick for `@aws-sdk/*`. Two
 * benefits:
 *
 *   1. The exporter services can compile and unit-test even when the
 *      heavy native deps haven't been `pnpm install`ed yet (CI, mock
 *      paths, fast-feedback loops).
 *   2. We can fail fast at the *first* exporter call with a stable
 *      `ErrorCode.EXTERNAL_SERVICE_ERROR` instead of an opaque
 *      `Cannot find module` boot error that would crash the API
 *      process altogether.
 *
 * Tests inject a fake loader by overriding the module returned from
 * `loadOrThrow` via the public setter on the exporter services.
 */

export type ModuleLoader<T> = () => Promise<T>;

export async function loadOrThrow<T>(packageName: string, loader: ModuleLoader<T>): Promise<T> {
  try {
    const mod = await loader();
    if (!mod) {
      throw new Error(`Module ${packageName} loaded as falsy value`);
    }
    return mod;
  } catch (err) {
    throw new ExternalServiceException(packageName, err as Error, ErrorCode.EXTERNAL_SERVICE_ERROR);
  }
}
