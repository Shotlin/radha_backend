import { Global, Module } from '@nestjs/common';

import { EmailService } from './email.service';
import { MockEmailProvider } from './providers/mock-email.provider';
import { SesEmailProvider } from './providers/ses-email.provider';

@Global()
@Module({
  providers: [MockEmailProvider, SesEmailProvider, EmailService],
  exports: [EmailService, MockEmailProvider, SesEmailProvider],
})
export class EmailModule {}
