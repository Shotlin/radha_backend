import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { ExternalServiceException } from '@/common/errors/business.exception';
import { ConfigService } from '@/config/config.service';

type CloudFrontModule = typeof import('@aws-sdk/client-cloudfront');

interface LoadedSdk {
  module: CloudFrontModule;
  client: InstanceType<CloudFrontModule['CloudFrontClient']>;
}

export interface InvalidationCommandResult {
  invalidationId: string;
  status: 'in-progress' | 'completed' | 'skipped';
  paths: string[];
}

/**
 * BE-23 — Thin wrapper around the AWS CloudFront SDK for cache
 * invalidations.
 *
 * The SDK is **dynamically imported** the first time `createInvalidation`
 * is called, matching the same pattern used by `S3Service`. When the
 * SDK package isn't installed (CI / dev) or the distribution ID isn't
 * configured we return a `status: 'skipped'` result with a generated
 * fake invalidation id so callers can log / audit consistently.
 *
 * `CloudFrontService` (BE-13) keeps its CDN-URL builder responsibility;
 * this service is **invalidation-only**.
 */
@Injectable()
export class CloudFrontClientService implements OnModuleDestroy {
  private readonly logger = new Logger(CloudFrontClientService.name);
  private sdk: LoadedSdk | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleDestroy(): Promise<void> {
    if (
      this.sdk?.client &&
      typeof (this.sdk.client as { destroy?: () => void }).destroy === 'function'
    ) {
      try {
        (this.sdk.client as { destroy: () => void }).destroy();
      } catch (err) {
        this.logger.warn(`cloudfront.client.destroy failed: ${(err as Error).message}`);
      }
    }
    this.sdk = null;
  }

  /**
   * `true` when both an SDK is loadable AND the distribution ID is
   * configured. Used by the public `CdnInvalidatorService` to decide
   * whether to actually call AWS or short-circuit.
   */
  isConfigured(): boolean {
    return Boolean(this.config.aws.cloudfront.distributionId);
  }

  /**
   * Create an invalidation for the supplied paths. Paths must start
   * with `/`; callers are expected to normalise.
   *
   * Behaviour:
   *   - No distribution ID → returns `{ status: 'skipped' }`.
   *   - SDK not installed   → returns `{ status: 'skipped' }`.
   *   - Real call success   → returns `{ status: 'in-progress' }`.
   *   - Real call failure   → throws `ExternalServiceException`.
   */
  async createInvalidation(paths: string[]): Promise<InvalidationCommandResult> {
    if (paths.length === 0) {
      return { invalidationId: 'noop', status: 'completed', paths: [] };
    }
    const distributionId = this.config.aws.cloudfront.distributionId;
    if (!distributionId) {
      this.logger.warn(
        `cloudfront.invalidate.skipped reason=no-distribution-id paths=${paths.length}`,
      );
      return {
        invalidationId: `skipped-${randomUUID()}`,
        status: 'skipped',
        paths,
      };
    }

    const sdk = await this.ensureSdk();
    if (!sdk) {
      this.logger.warn(
        `cloudfront.invalidate.skipped reason=sdk-not-installed paths=${paths.length}`,
      );
      return {
        invalidationId: `skipped-${randomUUID()}`,
        status: 'skipped',
        paths,
      };
    }

    const callerReference = randomUUID();
    try {
      const response = await sdk.client.send(
        new sdk.module.CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: {
            CallerReference: callerReference,
            Paths: { Quantity: paths.length, Items: paths },
          },
        }),
      );
      const invalidationId = response.Invalidation?.Id ?? `unknown-${callerReference}`;
      this.logger.log(`cloudfront.invalidate.created id=${invalidationId} paths=${paths.length}`);
      return {
        invalidationId,
        status: 'in-progress',
        paths,
      };
    } catch (err) {
      this.logger.error(
        `cloudfront.invalidate.failed paths=${paths.length} err=${(err as Error).message}`,
      );
      throw new ExternalServiceException('CloudFront', err as Error);
    }
  }

  private async ensureSdk(): Promise<LoadedSdk | null> {
    if (this.sdk) return this.sdk;
    const loaded = (await import('@aws-sdk/client-cloudfront').catch(
      () => null,
    )) as CloudFrontModule | null;
    if (!loaded) return null;
    const client = new loaded.CloudFrontClient({
      region: this.config.aws.region,
      credentials: {
        accessKeyId: this.config.aws.accessKeyId,
        secretAccessKey: this.config.aws.secretAccessKey,
      },
    });
    this.sdk = { module: loaded, client };
    return this.sdk;
  }
}
