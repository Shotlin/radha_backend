export interface EmailResult {
  success: boolean;
  messageId?: string;
  provider: 'ses' | 'mock';
  error?: string;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export type EmailTemplate =
  | 'password-reset'
  | 'email-verification'
  | 'admin-invitation'
  | 'login-alert'
  | 'account-locked';

export interface EmailTemplateData {
  'password-reset': { name: string; resetLink: string; expiresIn: string };
  'email-verification': { name: string; verifyLink: string };
  'admin-invitation': { inviterName: string; acceptLink: string; expiresIn: string };
  'login-alert': { name: string; ipAddress: string; deviceInfo: string; loginTime: string };
  'account-locked': { name: string; unlockAt: string; reason: string };
}

export interface IEmailProvider {
  send(params: SendEmailParams): Promise<EmailResult>;
}
