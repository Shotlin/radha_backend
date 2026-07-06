/**
 * BE-23 — Sharp loader + image-optimisation helpers.
 *
 * `sharp` is a native libvips binding; importing it eagerly at module
 * boot makes the API process refuse to start when the native binary
 * isn't compiled for the current platform (a real risk on Windows
 * dev machines). We follow the same dynamic-import pattern as
 * `S3Service` and the AI providers — the API stays up, and a
 * `null` return is converted to an explicit `unavailable` flag at the
 * call site.
 */

export type SharpFactory = (input?: Buffer) => unknown;

// `sharp` doesn't ship an `default` export but the package's namespace
// has its factory function; we mirror the call shape with a typed
// minimal facade so we never depend on `sharp/index.d.ts` types being
// resolvable in the consumer's tsconfig.
export interface SharpInstance {
  metadata(): Promise<SharpMetadata>;
  rotate(): SharpInstance;
  resize(opts: SharpResizeOptions): SharpInstance;
  webp(opts: SharpFormatOptions): SharpInstance;
  jpeg(opts: SharpFormatOptions): SharpInstance;
  png(opts: SharpFormatOptions): SharpInstance;
  withMetadata(opts: Record<string, unknown>): SharpInstance;
  toBuffer(): Promise<Buffer>;
}

export interface SharpResizeOptions {
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  withoutEnlargement?: boolean;
}

export interface SharpFormatOptions {
  quality?: number;
  effort?: number;
  compressionLevel?: number;
  progressive?: boolean;
}

export interface SharpMetadata {
  width?: number;
  height?: number;
  format?: string;
  size?: number;
  channels?: number;
  density?: number;
  exif?: Buffer;
  orientation?: number;
}

export type SharpModule = (input: Buffer) => SharpInstance;

const UNAVAILABLE = Symbol('sharp-unavailable');
let cached: SharpModule | typeof UNAVAILABLE | null | undefined;

/**
 * Lazy-loads the `sharp` package. Returns `null` when the native
 * binary isn't available on this platform.
 *
 * The cache is module-scoped; the first failed attempt is *not*
 * cached (returns `null` but next call retries) so a developer who
 * just installed `sharp` doesn't have to restart Node.
 *
 * Tests can call `__setSharpForTests(null)` to explicitly mark the
 * loader as unavailable without triggering a real `import('sharp')`.
 */
export const loadSharp = async (): Promise<SharpModule | null> => {
  if (cached === UNAVAILABLE) return null;
  if (typeof cached === 'function') return cached;
  try {
    const mod = (await import('sharp')) as { default?: SharpModule } | SharpModule;
    const factory = (
      typeof mod === 'function' ? mod : (mod as { default?: SharpModule }).default
    ) as SharpModule | undefined;
    if (typeof factory !== 'function') {
      return null;
    }
    cached = factory;
    return factory;
  } catch {
    return null;
  }
};

/**
 * Test seam — overrides the cached loader. Production code never
 * calls this. Tests use it to inject a deterministic Sharp double.
 *
 *   - `factory`         → cache to this factory (subsequent loadSharp calls return it).
 *   - `null`            → mark loader as explicitly unavailable so
 *                          `loadSharp` returns null without hitting `import()`.
 *   - `undefined`       → reset cache to default (next call will attempt real import).
 */
export const __setSharpForTests = (factory: SharpModule | null | undefined): void => {
  if (factory === null) {
    cached = UNAVAILABLE;
  } else {
    cached = factory;
  }
};

/**
 * Compute the size-reduction ratio for telemetry. Always falls back
 * to 1 when the original was 0 bytes (defensive — should never
 * happen given pre-upload validation).
 */
export const computeOptimizationRatio = (
  originalBytes: number,
  totalProcessedBytes: number,
): number => {
  if (!Number.isFinite(originalBytes) || originalBytes <= 0) return 1;
  if (!Number.isFinite(totalProcessedBytes) || totalProcessedBytes < 0) return 1;
  return Number((totalProcessedBytes / originalBytes).toFixed(4));
};
