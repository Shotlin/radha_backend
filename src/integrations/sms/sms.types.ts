export interface SmsResult {
  success: boolean;
  messageId?: string;
  provider: '2factor' | 'mock';
  cost?: number;
  error?: string;
}

export interface ISmsProvider {
  sendOtp(mobile: string, otp: string): Promise<SmsResult>;
  sendNotification(mobile: string, message: string, templateId?: string): Promise<SmsResult>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
