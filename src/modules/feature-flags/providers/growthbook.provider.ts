import { Injectable } from '@nestjs/common';

import { IFlagProvider } from '../types/feature-flag.types';

/**
 * BE-47 — GrowthBook provider stub.
 *
 * Mirror of `UnleashProvider` — present only so `FF_PROVIDER` can be
 * re-bound to a real GrowthBook integration without restructuring
 * the module wiring. Throws on every call until configured; the
 * service treats thrown errors as transient and falls back to flag
 * defaults.
 */
@Injectable()
export class GrowthbookProvider implements IFlagProvider {
  async evaluate(_flagName: string, _bucketKey: string): Promise<string> {
    throw new Error('GrowthbookProvider not configured');
  }

  async list(): Promise<string[]> {
    throw new Error('GrowthbookProvider not configured');
  }

  async refresh(): Promise<void> {
    throw new Error('GrowthbookProvider not configured');
  }
}
