import { ConfigService } from '@/config/config.service';

import { EmailService } from '../email.service';
import { MockEmailProvider } from '../providers/mock-email.provider';
import { SesEmailProvider } from '../providers/ses-email.provider';

const buildService = (
  isProd: boolean,
  alertEmail: string | undefined,
): { svc: EmailService; mock: MockEmailProvider } => {
  const mock = new MockEmailProvider();
  const ses = { send: jest.fn() } as unknown as SesEmailProvider;
  const cfg = {
    isProduction: isProd,
    isStaging: false,
    observability: { criticalAlertEmail: alertEmail },
  } as unknown as ConfigService;
  const svc = new EmailService(cfg, ses, mock);
  return { svc, mock };
};

describe('EmailService', () => {
  it('uses mock provider in dev even with alert email set', async () => {
    const { svc, mock } = buildService(false, 'ops@radha.app');
    await svc.send({ to: 'a@b.com', subject: 's', html: '<p>x</p>' });
    expect(mock.getOutbox()).toHaveLength(1);
  });

  it('uses mock when alert email is undefined in prod', async () => {
    const { svc, mock } = buildService(true, undefined);
    await svc.send({ to: 'a@b.com', subject: 's', html: '<p>x</p>' });
    expect(mock.getOutbox()).toHaveLength(1);
  });

  it('renders templates and writes through to the provider', async () => {
    const { svc, mock } = buildService(false, undefined);
    await svc.sendTemplate('password-reset', 'a@b.com', {
      name: 'A',
      resetLink: 'https://r/x',
      expiresIn: '1 hour',
    });
    const sent = mock.getOutbox();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('RADHA — Password reset');
    expect(sent[0].html).toContain('https://r/x');
  });
});
