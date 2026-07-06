import { Injectable } from '@nestjs/common';

import { IFlagProvider } from '../types/feature-flag.types';

/**
 * BE-47 — Unleash provider stub.
 *
 * Kept here as a swap-in point. When we adopt Unleash we'll wire its
 * SDK in this file and bind `FF_PROVIDER` to it in the module. Until
 * then it throws on every call so a misconfiguration fails loud
 * instead of silently degrading evaluations to `'off'`.
 *
 * The service catches these throws and falls back to the flag's
 * default per the BE-47 contract, so even an accidentally-wired stub
 * does not bring down the API.
 */
@Injectable()
export class UnleashProvider implements IFlagProvider {
  async evaluate(_flagName: string, _bucketKey: string): Promise<string> {
    throw new Error('UnleashProvider not configured');
  }

  async list(): Promise<string[]> {
    throw new Error('UnleashProvider not configured');
  }

  async refresh(): Promise<void> {
    throw new Error('UnleashProvider not configured');
  }
}
