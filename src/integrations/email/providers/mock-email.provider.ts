import { Injectable, Logger } from '@nestjs/common';

import type { EmailResult, IEmailProvider, SendEmailParams } from '../email.types';

@Injectable()
export class MockEmailProvider implements IEmailProvider {
  private readonly logger = new Logger(MockEmailProvider.name);
  private readonly outbox: Array<SendEmailParams & { sentAt: Date }> = [];

  async send(params: SendEmailParams): Promise<EmailResult> {
    this.logger.warn(
      `[MOCK EMAIL] to=${params.to} subject=${params.subject}\n--- begin body ---\n${params.html}\n--- end body ---`,
    );
    this.outbox.push({ ...params, sentAt: new Date() });
    return { success: true, provider: 'mock', messageId: `mock-email-${Date.now()}` };
  }

  /** Test helper. */
  getOutbox(): ReadonlyArray<SendEmailParams & { sentAt: Date }> {
    return [...this.outbox];
  }

  /** Test helper. */
  clearOutbox(): void {
    this.outbox.length = 0;
  }
}
