/**
 * OpenTelemetry SDK bootstrap (BE-48).
 *
 * Initialises a `NodeSDK` with the OTLP-HTTP trace exporter, exporting
 * to a Grafana-Cloud-compatible endpoint set via
 * `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * Like `sentry.bootstrap.ts`, this module is deliberately framework-
 * agnostic so it can be invoked at the very top of `main.api.ts` /
 * worker / scheduler entrypoints, *before* NestJS instantiates the
 * application. Both `@opentelemetry/sdk-node` and the OTLP exporter
 * are optional runtime dependencies — if they're missing the
 * bootstrap quietly degrades to a no-op.
 *
 * Service name is hard-coded to `radha-backend` per BE-48 spec (the
 * single resource the entire NestJS modulith reports as).
 */

interface OtelSdkLike {
  start(): void;
  shutdown(): Promise<void>;
}

let otelSdk: OtelSdkLike | null = null;
let initialized = false;

const DEFAULT_SERVICE_NAME = 'radha-backend';

interface InitOtelOptions {
  /**
   * OTLP HTTP endpoint; defaults to `process.env.OTEL_EXPORTER_OTLP_ENDPOINT`.
   * If empty, the bootstrap is a no-op.
   */
  endpoint?: string;
  /** Override the OTel resource service name. */
  serviceName?: string;
  /** Override the resource environment tag (defaults to `NODE_ENV`). */
  environment?: string;
}

/**
 * Initialise the OpenTelemetry NodeSDK.
 *
 * No-op when:
 *   - `endpoint` (or `process.env.OTEL_EXPORTER_OTLP_ENDPOINT`) is empty,
 *   - the `@opentelemetry/sdk-node` package cannot be loaded.
 *
 * Returns the SDK reference on success, or `null` otherwise. Always
 * resolves; never throws.
 */
export async function initOtel(options: InitOtelOptions = {}): Promise<OtelSdkLike | null> {
  initialized = true;

  const endpoint = options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || endpoint.length === 0) {
    return null;
  }

  // Dynamic imports — both packages are optional. Either failing
  // (e.g. running in a test environment without observability deps
  // installed) silently degrades to a no-op so the application boots
  // anyway.
  type SdkModule = { NodeSDK: new (config: Record<string, unknown>) => OtelSdkLike };
  type ExporterModule = { OTLPTraceExporter: new (config: Record<string, unknown>) => unknown };

  let sdkModule: SdkModule | null = null;
  let exporterModule: ExporterModule | null = null;

  // The module specifiers are read from variables so TypeScript
  // doesn't try to resolve the (intentionally optional) packages at
  // compile time. This keeps `tsc` clean even on installs that
  // haven't pulled in the OTel SDK.
  const sdkPkg = '@opentelemetry/sdk-node';
  const exporterPkg = '@opentelemetry/exporter-trace-otlp-http';

  try {
    sdkModule = (await import(sdkPkg)) as unknown as SdkModule;
  } catch {
    return null;
  }

  try {
    exporterModule = (await import(exporterPkg)) as unknown as ExporterModule;
  } catch {
    return null;
  }

  if (!sdkModule || !exporterModule) return null;

  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
  const environment = options.environment ?? process.env.NODE_ENV ?? 'development';

  const traceExporter = new exporterModule.OTLPTraceExporter({ url: endpoint });

  // NodeSDK accepts `serviceName` directly and synthesises a resource
  // with `service.name`. We add `deployment.environment` via the
  // `resourceAttributes` shortcut which both the v0.45+ and v0.50+
  // SDK accept; older shapes ignore the unknown key harmlessly.
  let sdk: OtelSdkLike;
  try {
    sdk = new sdkModule.NodeSDK({
      serviceName,
      traceExporter,
      resourceAttributes: {
        'service.name': serviceName,
        'deployment.environment': environment,
      },
    });
    sdk.start();
  } catch {
    return null;
  }

  otelSdk = sdk;
  return sdk;
}

/**
 * Flushes pending spans and shuts down the OTel SDK. Call during
 * graceful shutdown of any process that called `initOtel`.
 */
export async function shutdownOtel(): Promise<void> {
  if (!otelSdk) return;
  try {
    await otelSdk.shutdown();
  } catch {
    // ignore — already exiting.
  }
  otelSdk = null;
  initialized = false;
}

/** Returns the active SDK ref, or `null` if uninitialised / disabled. */
export function getOtelSdk(): OtelSdkLike | null {
  return otelSdk;
}

/** Returns true once `initOtel` has been called, regardless of outcome. */
export function isOtelInitialized(): boolean {
  return initialized;
}

/** Test-only hook to reset module-level state between specs. */
export function __resetOtelForTests(): void {
  otelSdk = null;
  initialized = false;
}
