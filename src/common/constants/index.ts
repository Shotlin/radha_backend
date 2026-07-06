/**
 * Application-wide constants.
 *
 * Keep this file framework-agnostic. Anything that varies per environment
 * lives in `config/app.config.ts`, not here.
 */

export const APP_NAME = 'radha-server' as const;
export const API_DEFAULT_VERSION = '1' as const;
export const DEFAULT_REQUEST_ID_HEADER = 'x-request-id' as const;

export const SHUTDOWN_TIMEOUT_MS = 10_000 as const;
