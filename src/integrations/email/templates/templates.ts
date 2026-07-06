import type { EmailTemplate, EmailTemplateData } from '../email.types';

/**
 * Templates as plain typed render functions. Keeps the dependency
 * footprint minimal; we can switch to a real templating engine later
 * without changing every call site.
 *
 * Each template is intentionally short — these are transactional
 * security emails, not marketing copy.
 */

const escapeHtml = (input: string): string =>
  input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderers: { [K in EmailTemplate]: (data: EmailTemplateData[K]) => string } = {
  'password-reset': (d) => `<!doctype html>
    <html><body>
      <h1>Reset your RADHA password</h1>
      <p>Hi ${escapeHtml(d.name)},</p>
      <p>We received a password reset request. Click the link below within ${escapeHtml(d.expiresIn)} to choose a new password:</p>
      <p><a href="${escapeHtml(d.resetLink)}">Reset my password</a></p>
      <p>If you did not request this, you can ignore this email — no changes were made to your account.</p>
    </body></html>`,
  'email-verification': (d) => `<!doctype html>
    <html><body>
      <h1>Verify your RADHA email</h1>
      <p>Hi ${escapeHtml(d.name)},</p>
      <p>Confirm your email address by clicking the link below:</p>
      <p><a href="${escapeHtml(d.verifyLink)}">Verify email</a></p>
    </body></html>`,
  'admin-invitation': (d) => `<!doctype html>
    <html><body>
      <h1>You're invited to RADHA admin</h1>
      <p>${escapeHtml(d.inviterName)} has invited you. The link below is valid for ${escapeHtml(d.expiresIn)}.</p>
      <p><a href="${escapeHtml(d.acceptLink)}">Accept invitation</a></p>
    </body></html>`,
  'login-alert': (d) => `<!doctype html>
    <html><body>
      <h1>New login on your RADHA admin account</h1>
      <p>Hi ${escapeHtml(d.name)},</p>
      <p>We detected a new sign-in on ${escapeHtml(d.loginTime)}.</p>
      <ul>
        <li>IP address: ${escapeHtml(d.ipAddress)}</li>
        <li>Device: ${escapeHtml(d.deviceInfo)}</li>
      </ul>
      <p>If this wasn't you, change your password immediately.</p>
    </body></html>`,
  'account-locked': (d) => `<!doctype html>
    <html><body>
      <h1>Your RADHA admin account is locked</h1>
      <p>Hi ${escapeHtml(d.name)},</p>
      <p>${escapeHtml(d.reason)}</p>
      <p>The lock will lift at ${escapeHtml(d.unlockAt)}.</p>
    </body></html>`,
};

const subjects: Record<EmailTemplate, string> = {
  'password-reset': 'RADHA — Password reset',
  'email-verification': 'RADHA — Verify your email',
  'admin-invitation': 'RADHA — Admin invitation',
  'login-alert': 'RADHA — New sign-in detected',
  'account-locked': 'RADHA — Account locked',
};

export const renderEmailTemplate = <T extends EmailTemplate>(
  template: T,
  data: EmailTemplateData[T],
): string => renderers[template](data);

export const subjectFor = (template: EmailTemplate): string => subjects[template];
