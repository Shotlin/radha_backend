import { NotFoundException } from '@nestjs/common';

import { UserLanguageService } from '../services/user-language.service';

describe('UserLanguageService', () => {
  let svc: UserLanguageService;

  let users: {
    findById: jest.Mock;
    update: jest.Mock;
  };
  let logger: {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
    debug: jest.Mock;
  };

  beforeEach(() => {
    users = {
      findById: jest.fn(),
      update: jest.fn(),
    };
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    svc = new UserLanguageService(users as never, logger as never);
  });

  it('persists the new language and reports changed=true', async () => {
    users.findById.mockResolvedValue({ id: 'u1', preferredLanguage: 'en' });
    users.update.mockResolvedValue({ id: 'u1', preferredLanguage: 'hi' });

    const out = await svc.updatePreferredLanguage('u1', 'hi');

    expect(out).toEqual({ preferredLanguage: 'hi', changed: true });
    expect(users.update).toHaveBeenCalledWith('u1', { preferredLanguage: 'hi' });
    expect(logger.info).toHaveBeenCalledWith('user_language.updated', {
      userId: 'u1',
      previous: 'en',
      next: 'hi',
    });
  });

  it('is idempotent — same value returns changed=false and skips the write', async () => {
    users.findById.mockResolvedValue({ id: 'u1', preferredLanguage: 'ta' });

    const out = await svc.updatePreferredLanguage('u1', 'ta');

    expect(out).toEqual({ preferredLanguage: 'ta', changed: false });
    expect(users.update).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("treats a missing preferred_language as 'en' for the diff check", async () => {
    users.findById.mockResolvedValue({ id: 'u1' }); // no preferredLanguage
    users.update.mockResolvedValue({ id: 'u1', preferredLanguage: 'mr' });

    const out = await svc.updatePreferredLanguage('u1', 'mr');

    expect(out).toEqual({ preferredLanguage: 'mr', changed: true });
    expect(users.update).toHaveBeenCalledWith('u1', { preferredLanguage: 'mr' });
  });

  it("treats a missing preferred_language as 'en' — no-op when target is en", async () => {
    users.findById.mockResolvedValue({ id: 'u1' }); // no preferredLanguage

    const out = await svc.updatePreferredLanguage('u1', 'en');

    expect(out).toEqual({ preferredLanguage: 'en', changed: false });
    expect(users.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the user does not exist', async () => {
    users.findById.mockResolvedValue(null);

    await expect(svc.updatePreferredLanguage('missing', 'bn')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(users.update).not.toHaveBeenCalled();
  });
});
