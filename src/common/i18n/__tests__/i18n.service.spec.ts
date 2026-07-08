import { I18nService } from '../i18n.service';

describe('I18nService', () => {
  let svc: I18nService;

  beforeEach(() => {
    svc = new I18nService();
    svc.onModuleInit();
  });

  describe('t() — straight lookups', () => {
    it('returns the English value for a known key', () => {
      expect(svc.t('common.app_name', 'en')).toBe('RADHA');
    });

    it('returns the Hindi value for a known key', () => {
      // Devanagari "RADHA" — sanity check the file is loaded as UTF-8.
      expect(svc.t('common.app_name', 'hi')).toBe('राधा');
    });

    it('returns the Tamil value for a known key', () => {
      expect(svc.t('common.app_name', 'ta')).toBe('ராதா');
    });

    it('walks nested keys (notifications.recall_alert.title)', () => {
      expect(svc.t('notifications.recall_alert.title', 'en')).toBe('Product recall alert');
      expect(svc.t('notifications.recall_alert.title', 'hi')).toBe('उत्पाद वापसी चेतावनी');
    });
  });

  describe('t() — interpolation', () => {
    it('replaces {paramName} with provided params', () => {
      const out = svc.t('common.greeting', 'en', { name: 'Asha' });
      expect(out).toBe('Hello, Asha!');
    });

    it('handles multiple placeholders in a single template', () => {
      const out = svc.t('notifications.expiry.near', 'en', { name: 'Milk', days: '3' });
      expect(out).toBe('Milk is expiring soon (3 days left).');
    });

    it('leaves unknown placeholders intact', () => {
      const out = svc.t('common.greeting', 'en', { somethingElse: 'x' });
      expect(out).toBe('Hello, {name}!');
    });

    it('returns the raw template when no params are passed', () => {
      expect(svc.t('common.greeting', 'en')).toBe('Hello, {name}!');
    });

    it('interpolates against translated values too', () => {
      const out = svc.t('common.greeting', 'hi', { name: 'आशा' });
      expect(out).toBe('नमस्ते, आशा!');
    });
  });

  describe('t() — fallback semantics', () => {
    it('falls back to English when the locale is missing the key', () => {
      // Simulate Hindi missing `common.welcome` — patch the loaded tree.
      const hiTree = svc.getTranslations('hi') as { common: Record<string, unknown> };
      delete hiTree.common.welcome;
      expect(svc.t('common.welcome', 'hi')).toBe('Welcome to RADHA.');
    });

    it('returns the key itself when missing in the locale and in English', () => {
      expect(svc.t('does.not.exist.anywhere', 'hi')).toBe('does.not.exist.anywhere');
      expect(svc.t('does.not.exist.anywhere', 'en')).toBe('does.not.exist.anywhere');
    });

    it('returns the key when the dotted path lands on a non-string', () => {
      // `notifications.recall_alert` is a sub-tree, not a string.
      expect(svc.t('notifications.recall_alert', 'en')).toBe('notifications.recall_alert');
    });

    it('returns an empty string unchanged', () => {
      expect(svc.t('', 'en')).toBe('');
    });
  });

  describe('reload()', () => {
    it('rehydrates the in-memory translation map', () => {
      const tree = svc.getTranslations('en') as { common: Record<string, unknown> };
      delete tree.common.app_name;
      expect(svc.t('common.app_name', 'en')).toBe('common.app_name');
      svc.reload();
      expect(svc.t('common.app_name', 'en')).toBe('RADHA');
    });
  });
});
