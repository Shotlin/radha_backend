import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';

import type { EmailResult, IEmailProvider, SendEmailParams } from '../email.types';

/**
 * AWS SES provider stub.
 *
 * BE-07 ships the wiring; the actual `@aws-sdk/client-ses` import is
 * loaded lazily so we don't pull in the SDK at boot when the provider
 * isn't selected (`EMAIL_PROVIDER=mock` in dev).
 *
 * BE-24 (Notifications) will extend this provider with batched
 * digests and templated transactional sends.
 */
@Injectable()
export class SesEmailProvider implements IEmailProvider {
  private readonly logger = new Logger(SesEmailProvider.name);

  constructor(private readonly config: ConfigService) {}

  async send(params: SendEmailParams): Promise<EmailResult> {
    const { region } = this.config.aws;
    try {
      // SES SDK is an optional runtime dep; resolve via a string
      // module name so TypeScript doesn't need ambient types when the
      // package isn't installed in dev.
      const moduleName = '@aws-sdk/client-ses';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(moduleName).catch(() => null);
      if (!mod) {
        this.logger.warn('ses.disabled', { reason: '@aws-sdk/client-ses not installed' });
        return { success: false, provider: 'ses', error: 'SES SDK not installed' };
      }
      const client = new mod.SESClient({ region });
      const fromAddress = this.config.observability.criticalAlertEmail ?? 'noreply@radha.app';
      const command = new mod.SendEmailCommand({
        Source: fromAddress,
        Destination: { ToAddresses: [params.to] },
        Message: {
          Subject: { Data: params.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: params.html, Charset: 'UTF-8' },
            ...(params.text ? { Text: { Data: params.text, Charset: 'UTF-8' } } : {}),
          },
        },
      });
      const response = await client.send(command);
      return { success: true, provider: 'ses', messageId: response.MessageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.error('ses.send.failed', { message });
      return { success: false, provider: 'ses', error: message };
    }
  }
}
