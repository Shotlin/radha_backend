import type { FcmFailureReason } from '@/modules/notifications/types/notification.types';

export interface FcmSendParams {
  /** Single token or array of tokens (FCM caps multicast at 500 tokens). */
  tokens: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
  /** APNs/FCM priority. `high` = wake screen on Android, `normal` = bundled. */
  priority?: 'high' | 'normal';
  /** Optional click action / deep link rendered by the Mobile_App. */
  clickAction?: string;
  imageUrl?: string;
}

export interface FcmTokenResult {
  token: string;
  success: boolean;
  messageId?: string;
  error?: string;
  reason?: FcmFailureReason;
  /** Whether the token should be marked invalid permanently. */
  permanentFailure: boolean;
}

export interface FcmSendResult {
  successCount: number;
  failureCount: number;
  perToken: FcmTokenResult[];
  /** True when the entire request itself failed (e.g. bad credentials). */
  globalError?: string;
}

export interface IFcmService {
  send(params: FcmSendParams): Promise<FcmSendResult>;
  isAvailable(): boolean;
}
