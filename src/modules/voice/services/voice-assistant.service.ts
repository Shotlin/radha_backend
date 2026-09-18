import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import { PermissionsService } from '@/modules/auth/services/permissions.service';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import { extractJsonCandidate } from '@/integrations/ai/utils/ocr-text-parser.utils';
import { LlmService } from '@/integrations/ai/services/llm.service';
import { UsageTrackerService } from '@/integrations/ai/services/usage-tracker.service';

import { VoiceTurnRequestDto } from '../dto/voice-assistant.dto';
import { BusinessSnapshotService } from './business-snapshot.service';
import { buildVoiceTemplateAnswer } from './voice-template-answer';
import { BusinessSnapshot, VoiceAction, VoiceActionKind, VoiceTurnResult } from '../types/voice.types';
import { clampSpoken, renderSnapshotText } from '../utils/voice-text.utils';

/**
 * Text-only model, chosen deliberately over gpt-4o-mini (used for the
 * date-scanning vision path) — this step never sees an image, so
 * gpt-4o-mini's vision capability would be paid for and wasted. Routed
 * through the same OpenRouter key already configured for date-photo-
 * analysis / no separate credential needed. See AI_OPERATION_UNIT_COST
 * for the per-call cost rationale.
 */
const VOICE_MODEL = 'deepseek/deepseek-v4-flash-0731';

const VOICE_LLM_TIMEOUT_MS = 12_000;
const VOICE_LLM_MAX_TOKENS = 220;

/** Action kinds the LLM is allowed to emit today. Phase 2/3 will extend
 * this — the response TYPE already models the full union (see voice.types.ts)
 * so the contract never needs to change shape, only what's accepted here. */
const ALLOWED_ACTION_KINDS: ReadonlySet<VoiceActionKind> = new Set(['none', 'clarify']);

interface RawLlmVoiceResponse {
  spokenText?: unknown;
  displayText?: unknown;
  action?: { kind?: unknown } | null;
}

@Injectable()
export class VoiceAssistantService {
  constructor(
    private readonly snapshotService: BusinessSnapshotService,
    private readonly llm: LlmService,
    private readonly usageTracker: UsageTrackerService,
    private readonly permissions: PermissionsService,
    private readonly logger: LoggerService,
  ) {}

  async handleTurn(user: AuthenticatedUser, dto: VoiceTurnRequestDto): Promise<VoiceTurnResult> {
    if (!this.permissions.canAccessStore(user, dto.storeId)) {
      throw new BusinessException(ErrorCode.STORE_ACCESS_DENIED, 'Access to this store is denied', {
        metadata: { storeId: dto.storeId },
      });
    }

    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, 'A tenant is required for the voice assistant');
    }

    const check = await this.usageTracker.checkLimit(tenantId, 'voice-assistant');
    if (!check.allowed) {
      throw new BusinessException(
        ErrorCode.PLAN_LIMIT_EXCEEDED,
        check.reason ?? 'Voice assistant usage limit exceeded',
        { metadata: { operation: 'voice-assistant', used: check.used, limit: check.limit } },
      );
    }

    const snapshot = await this.snapshotService.build(tenantId, dto.storeId);

    try {
      const prompt = this.buildPrompt(snapshot, dto);
      const llmResult = await this.llm.complete(prompt, {
        json: true,
        maxTokens: VOICE_LLM_MAX_TOKENS,
        temperature: 0.2,
        timeoutMs: VOICE_LLM_TIMEOUT_MS,
        model: VOICE_MODEL,
      });

      // LlmService.complete() never throws — a mis/unconfigured provider or
      // an open circuit breaker both come back as a mock-provider result.
      // Feeding that canned text through the parser below would produce a
      // confident-sounding but fabricated answer about a real shop's data,
      // so it's treated as a hard degrade signal instead.
      if (llmResult.provider === 'mock') {
        return buildVoiceTemplateAnswer(snapshot, dto);
      }

      const parsed = this.parseResponse(llmResult.text);
      if (!parsed) {
        this.logger.warn('voice.assistant.unparseable_response', {
          tenantId,
          storeId: dto.storeId,
        });
        return buildVoiceTemplateAnswer(snapshot, dto);
      }

      await this.usageTracker.trackUsage({
        tenantId,
        operation: 'voice-assistant',
        provider: llmResult.provider,
        cost: llmResult.cost,
        durationMs: llmResult.durationMs,
        success: true,
        userId: user.id,
      });

      return {
        turnId: randomUUID(),
        spokenText: clampSpoken(parsed.spokenText),
        displayText: parsed.displayText,
        action: parsed.action,
        source: 'llm',
        degraded: false,
      };
    } catch (err) {
      this.logger.warn('voice.assistant.turn_failed', {
        tenantId,
        storeId: dto.storeId,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return buildVoiceTemplateAnswer(snapshot, dto);
    }
  }

  private buildPrompt(snapshot: BusinessSnapshot, dto: VoiceTurnRequestDto): string {
    const snapshotText = renderSnapshotText(snapshot);
    const localeName = dto.locale === 'hi' ? 'Hindi' : 'English';

    const responseContract =
      'Reply with exactly one JSON object and nothing else — no markdown, no code fences, ' +
      'no text before or after it. Shape: ' +
      '{"spokenText": string, "displayText": string, "action": {"kind": "none"|"clarify"}}.';

    const spokenRules =
      'spokenText will be READ ALOUD by a text-to-speech engine that cannot handle long input — ' +
      'it MUST be at most 2 short sentences and at most 220 characters. Plain spoken ' +
      `${localeName}, no bullet points, no symbols, no markdown. Write numbers in words when ` +
      'natural (e.g. "twelve items"), not digits.';

    const groundingRules =
      'Answer ONLY using the STORE DATA below — never invent a number or fact that is not in it. ' +
      'If STORE DATA does not contain the answer, say so honestly in spokenText and set ' +
      'action.kind to "none". If the question is ambiguous or you need one more detail to answer ' +
      'it, set action.kind to "clarify" and ask exactly one short clarifying question as spokenText.';

    if (dto.intent === 'daily_summary') {
      return [
        `You are RADHA's shop assistant, giving a short morning briefing to a shop owner in ${localeName}.`,
        responseContract,
        'spokenText must be at most 3 short sentences and at most 240 characters total, covering: ' +
          'what is expiring soon, anything overdue, and one useful next step. action.kind must be "none".',
        groundingRules,
        '',
        'STORE DATA:',
        snapshotText,
      ].join('\n');
    }

    return [
      `You are RADHA's shop assistant, answering a shop owner's spoken question in ${localeName}.`,
      responseContract,
      spokenRules,
      'displayText may be up to 3 short lines and may name specific products — it is shown on ' +
        'screen, not spoken, so it is not subject to the length limit above.',
      groundingRules,
      '',
      'STORE DATA:',
      snapshotText,
      '',
      `QUESTION: ${dto.transcript ?? ''}`,
    ].join('\n');
  }

  private parseResponse(raw: string): { spokenText: string; displayText?: string; action: VoiceAction } | null {
    try {
      const cleaned = extractJsonCandidate(raw);
      const parsed = JSON.parse(cleaned) as RawLlmVoiceResponse;
      const spokenText = typeof parsed.spokenText === 'string' ? parsed.spokenText.trim() : '';
      if (!spokenText) return null;

      const displayText =
        typeof parsed.displayText === 'string' && parsed.displayText.trim() ? parsed.displayText.trim() : undefined;

      const rawKind = parsed.action?.kind;
      const kind: VoiceActionKind =
        typeof rawKind === 'string' && ALLOWED_ACTION_KINDS.has(rawKind as VoiceActionKind)
          ? (rawKind as VoiceActionKind)
          : 'none';

      return { spokenText, displayText, action: { kind } };
    } catch {
      return null;
    }
  }
}
