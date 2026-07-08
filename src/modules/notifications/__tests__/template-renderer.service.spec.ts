import { TemplateRendererService } from '../services/template-renderer.service';
import { DEFAULT_TEMPLATES } from '../templates/default-templates';

const buildRepoStub = (storedTemplate: unknown = null) =>
  ({
    findEffective: jest.fn(async () => storedTemplate),
  }) as unknown as ConstructorParameters<typeof TemplateRendererService>[0];

describe('TemplateRendererService', () => {
  describe('render — defaults', () => {
    it('substitutes placeholders in the default template', async () => {
      const svc = new TemplateRendererService(buildRepoStub());
      const result = await svc.render(
        'task-assigned',
        {
          taskTitle: 'Aisle 3 audit',
          assignerName: 'Priya',
          dueAt: 'Mon 5 PM',
        },
        { tenantId: null },
      );

      expect(result.subject).toBe('New task assigned: Aisle 3 audit');
      expect(result.body).toContain('Priya assigned you "Aisle 3 audit"');
      expect(result.body).toContain('due Mon 5 PM');
      expect(result.html).toContain('<strong>Priya</strong>');
      expect(result.pushTitle).toBe('New task');
    });

    it('html-escapes user-supplied values into the html branch', async () => {
      const svc = new TemplateRendererService(buildRepoStub());
      const result = await svc.render(
        'task-assigned',
        {
          taskTitle: '<script>x</script>',
          assignerName: 'Mgr',
          dueAt: '5pm',
        },
        { tenantId: null },
      );

      expect(result.html).toContain('&lt;script&gt;x&lt;/script&gt;');
      // Plain-text branch keeps the raw value (renders harmlessly in
      // a text/plain context).
      expect(result.body).toContain('<script>x</script>');
    });

    it('renders the generic template via subject + body data', async () => {
      const svc = new TemplateRendererService(buildRepoStub());
      const result = await svc.render(
        'generic',
        {
          subject: 'Hello',
          body: 'World',
          html: '<p>World</p>',
        },
        { tenantId: null },
      );

      expect(result.subject).toBe('Hello');
      expect(result.body).toBe('World');
    });
  });

  describe('render — DB override wins over default', () => {
    it('uses the stored template when present', async () => {
      const repo = buildRepoStub({
        category: 'task',
        defaultChannels: ['email'],
        subject: 'Custom: {{taskTitle}}',
        body: 'Custom body for {{taskTitle}}',
        bodyHtml: '<p>Custom {{taskTitle}}</p>',
        smsText: null,
        pushTitle: null,
        pushBody: null,
      });

      const svc = new TemplateRendererService(repo);
      const result = await svc.render(
        'task-assigned',
        {
          taskTitle: 'Hello',
          assignerName: 'X',
          dueAt: 'Y',
        },
        { tenantId: 't1' },
      );

      expect(result.subject).toBe('Custom: Hello');
      expect(result.body).toBe('Custom body for Hello');
    });

    it('falls back to the default when the repo throws', async () => {
      const repo = {
        findEffective: jest.fn(async () => {
          throw new Error('db down');
        }),
      } as unknown as ConstructorParameters<typeof TemplateRendererService>[0];

      const svc = new TemplateRendererService(repo);
      const result = await svc.render(
        'task-assigned',
        { taskTitle: 'T', assignerName: 'A', dueAt: 'D' },
        { tenantId: null },
      );

      expect(result.subject).toBe('New task assigned: T');
    });
  });

  describe('default channel + category lookup', () => {
    it('returns the in-process default channel set', () => {
      const svc = new TemplateRendererService(buildRepoStub());
      expect(svc.defaultChannelsFor('task-assigned')).toEqual(
        DEFAULT_TEMPLATES['task-assigned'].defaultChannels,
      );
    });

    it('returns the category for a known template', () => {
      const svc = new TemplateRendererService(buildRepoStub());
      expect(svc.defaultCategoryFor('expiry-near')).toBe('expiry-alert');
    });
  });

  describe('renderString', () => {
    it('substitutes placeholders without HTML escaping', () => {
      const svc = new TemplateRendererService(buildRepoStub());
      const out = svc.renderString('Hello {{name}}', { name: 'World' });
      expect(out).toBe('Hello World');
    });

    it('html-escapes when requested', () => {
      const svc = new TemplateRendererService(buildRepoStub());
      const out = svc.renderString('<p>{{x}}</p>', { x: '<b>' }, true);
      expect(out).toBe('<p>&lt;b&gt;</p>');
    });
  });
});
