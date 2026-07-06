import { Injectable, Logger } from '@nestjs/common';

import { NotificationTemplatesRepository } from '../repositories/notification-templates.repository';
import { DEFAULT_TEMPLATES, type DefaultTemplate } from '../templates/default-templates';
import type {
  NotificationTemplateData,
  NotificationTemplateKey,
  RenderedTemplate,
} from '../types/notification.types';

/**
 * BE-24 — Template renderer.
 *
 * Looks up the effective template (tenant override → platform default
 * row → in-process fallback) and substitutes `{{key}}` placeholders.
 *
 * The substitutor is intentionally tiny — no nested logic, no helpers,
 * no escaping at the template level. Templates are authored by the
 * dev team and stored server-side; we never render user-controlled
 * template strings, so Mustache-class injection isn't a vector here.
 * HTML output is built from server-controlled strings; only the
 * placeholder VALUES come from the caller, and we HTML-escape those
 * before substitution into the HTML branch.
 */

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

@Injectable()
export class TemplateRendererService {
  private readonly logger = new Logger(TemplateRendererService.name);

  constructor(private readonly templatesRepo: NotificationTemplatesRepository) {}

  async render<K extends NotificationTemplateKey>(
    key: K,
    data: NotificationTemplateData[K],
    opts?: { tenantId?: string | null; locale?: string },
  ): Promise<RenderedTemplate> {
    const tenantId = opts?.tenantId ?? null;
    const locale = opts?.locale ?? 'en';

    const stored = await this.templatesRepo
      .findEffective(key, tenantId, locale)
      .catch((err: unknown) => {
        this.logger.warn('template.lookup.failed', {
          key,
          message: err instanceof Error ? err.message : 'unknown',
        });
        return null;
      });

    const tpl: DefaultTemplate = stored
      ? {
          category: stored.category,
          defaultChannels: stored.defaultChannels as DefaultTemplate['defaultChannels'],
          subject: stored.subject,
          body: stored.body,
          bodyHtml: stored.bodyHtml ?? '',
          smsText: stored.smsText ?? undefined,
          pushTitle: stored.pushTitle ?? undefined,
          pushBody: stored.pushBody ?? undefined,
        }
      : DEFAULT_TEMPLATES[key];

    if (!tpl) {
      throw new Error(`Unknown notification template key: ${String(key)}`);
    }

    const placeholders = this.toPlaceholders(data as Record<string, unknown>);

    return {
      subject: this.substitute(tpl.subject, placeholders, false),
      body: this.substitute(tpl.body, placeholders, false),
      html: this.substitute(tpl.bodyHtml, placeholders, true),
      smsText: tpl.smsText ? this.substitute(tpl.smsText, placeholders, false) : undefined,
      pushTitle: tpl.pushTitle ? this.substitute(tpl.pushTitle, placeholders, false) : undefined,
      pushBody: tpl.pushBody ? this.substitute(tpl.pushBody, placeholders, false) : undefined,
    };
  }

  /** Direct render of a string template — used by `send()` for ad-hoc bodies. */
  renderString(template: string, data: Record<string, unknown>, htmlEscape = false): string {
    return this.substitute(template, this.toPlaceholders(data), htmlEscape);
  }

  /**
   * Resolve the default channel set for a template key. Used by the
   * router when the caller didn't pass an explicit `channels` array.
   */
  defaultChannelsFor(key: NotificationTemplateKey): DefaultTemplate['defaultChannels'] {
    return DEFAULT_TEMPLATES[key]?.defaultChannels ?? ['in-app'];
  }

  defaultCategoryFor(key: NotificationTemplateKey): DefaultTemplate['category'] {
    return DEFAULT_TEMPLATES[key]?.category ?? 'system';
  }

  /* ─────────────────── Internal ─────────────────── */

  private substitute(
    template: string,
    placeholders: Map<string, string>,
    htmlEscape: boolean,
  ): string {
    return template.replace(PLACEHOLDER_RE, (match, key: string) => {
      const value = placeholders.get(key);
      if (value === undefined) return match;
      return htmlEscape ? this.escapeHtml(value) : value;
    });
  }

  private toPlaceholders(data: Record<string, unknown>): Map<string, string> {
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined) {
        out.set(k, '');
      } else {
        out.set(k, typeof v === 'string' ? v : String(v));
      }
    }
    return out;
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
