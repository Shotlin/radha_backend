import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';

import type {
  EmailResult,
  EmailTemplate,
  EmailTemplateData,
  IEmailProvider,
  SendEmailParams,
} from './email.types';
import { MockEmailProvider } from './providers/mock-email.provider';
import { SesEmailProvider } from './providers/ses-email.provider';
import { renderEmailTemplate, subjectFor } from './templates/templates';

/**
 * Public email façade.
 *
 *   - Picks `SesEmailProvider` whenever `criticalAlertEmail` is set
 *     and `nodeEnv` isn't `development`/`test`. Otherwise the mock
 *     provider runs (logs the body to stdout and stores it in an
 *     in-memory outbox so tests can inspect it).
 *
 *   - Templates live in `templates/templates.ts` so swapping the
 *     rendering engine (Handlebars, MJML, Resend's React-Email) later
 *     is a one-file change.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly provider: IEmailProvider;

  constructor(
    config: ConfigService,
    private readonly ses: SesEmailProvider,
    private readonly mock: MockEmailProvider,
  ) {
    const useSes =
      Boolean(config.observability.criticalAlertEmail) && (config.isProduction || config.isStaging);
    this.provider = useSes ? this.ses : this.mock;
    this.logger.log(`Email provider: ${useSes ? 'ses' : 'mock'}`);
  }

  send(params: SendEmailParams): Promise<EmailResult> {
    return this.provider.send(params);
  }

  sendTemplate<T extends EmailTemplate>(
    template: T,
    to: string,
    data: EmailTemplateData[T],
  ): Promise<EmailResult> {
    return this.provider.send({
      to,
      subject: subjectFor(template),
      html: renderEmailTemplate(template, data),
    });
  }

  /** Used by tests to inspect what would have been delivered. */
  getMockProvider(): MockEmailProvider {
    return this.mock;
  }
}
