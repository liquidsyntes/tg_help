/**
 * Draft Manager Application Service
 * Manages draft listing, resumption, granular field editing, and soft-deletion.
 * Authoritative reference: tasks.md § 9, § 10, § 11; AGENTS.md § 11, § 12, § 31, § 54
 */

import { Injectable, Optional } from '@nestjs/common';
import { PostStatus, Post } from '@prisma/client';
import { MessageEntity } from 'grammy/types';
import { PostsService } from '../../posts/posts.service';
import { PostsRepository } from '../../posts/posts.repository';
import { TemplatesService } from '../../templates/templates.service';
import { TemplateValidator } from '../../templates/template.validator';
import { RedisService } from '../../../infrastructure/redis/redis.service';
import { HtmlSanitizer } from '../../rendering/html-sanitizer.service';
import { StructuredLoggerService } from '../../../infrastructure/logger/structured-logger.service';
import {
  TemplateSchema,
  TemplateFieldDefinition,
} from '../../templates/interfaces/template.interface';
import { PostWithRelations } from './telegram-preview.service';
import { WizardSessionData } from '../interfaces/wizard-session.interface';
import { entitiesToHtml } from '../utils/entity-converter.util';

export interface DraftResumeResult {
  action: 'FIELD_PROMPT' | 'CONTROL_CARD' | 'ERROR';
  text: string;
  field?: TemplateFieldDefinition;
  post?: PostWithRelations;
}

@Injectable()
export class DraftManagerService {
  constructor(
    private readonly postsService: PostsService,
    private readonly postsRepository: PostsRepository,
    private readonly templatesService: TemplatesService,
    private readonly validator: TemplateValidator,
    private readonly redis: RedisService,
    private readonly htmlSanitizer: HtmlSanitizer,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {}

  private sessionKey(actorId: string): string {
    return `wizard:session:${actorId}`;
  }

  /**
   * Retrieves all active drafts and posts needing revision for the author.
   */
  async listDrafts(actorId: string): Promise<PostWithRelations[]> {
    const drafts = await this.postsRepository.findByAuthor(actorId, PostStatus.DRAFT);
    const revisions = await this.postsRepository.findByAuthor(
      actorId,
      PostStatus.NEEDS_REVISION,
    );

    const all = [...drafts, ...revisions];
    all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return all as PostWithRelations[];
  }

  /**
   * Resumes a draft:
   * If any required fields are missing -> resumes wizard at the first missing field.
   * If all required fields are filled -> displays preview and companion control card.
   */
  async resumeDraft(actorId: string, postId: string): Promise<DraftResumeResult> {
    const post = (await this.postsRepository.findById(postId)) as PostWithRelations | null;
    if (!post || post.deletedAt !== null) {
      return { action: 'ERROR', text: 'Черновик не найден или был удален.' };
    }

    const template = await this.templatesService.getById(post.templateId);
    const schema = template.schemaJson as unknown as TemplateSchema;
    const fields = schema?.fields || [];
    const content = (post.contentJson as Record<string, unknown>) || {};

    // Find first missing required field
    const firstUnfilledIndex = fields.findIndex((f) => {
      if (!f.required) return false;
      const val = content[f.key];
      return val === undefined || val === null || String(val).trim() === '';
    });

    if (firstUnfilledIndex !== -1) {
      const missingField = fields[firstUnfilledIndex]!;
      await this.redis.set(
        this.sessionKey(actorId),
        JSON.stringify({
          postId: post.id,
          channelId: post.channelId,
          templateId: post.templateId,
          step: 'FIELD_INPUT',
          fieldIndex: firstUnfilledIndex,
          expectedVersion: post.version,
        } as WizardSessionData),
        86400,
      );

      const text =
        `Шаг ${firstUnfilledIndex + 1} из ${fields.length}: <b>${missingField.label}</b>\n\n` +
        (missingField.hint ? `${missingField.hint}\n\n` : '') +
        `🔴 Обязательное поле\n\n` +
        `Введите значение:`;

      return {
        action: 'FIELD_PROMPT',
        text,
        field: missingField,
        post,
      };
    }

    // All required fields present -> show Control Card
    return {
      action: 'CONTROL_CARD',
      text: '📄 Черновик готов к просмотру:',
      post,
    };
  }

  /**
   * Starts editing a single field (F-14 Granular Field Editing).
   */
  async startEditField(
    actorId: string,
    postId: string,
    fieldKey: string,
  ): Promise<{ text: string; field: TemplateFieldDefinition }> {
    const post = await this.postsRepository.findById(postId);
    if (!post) throw new Error('Пост не найден');

    const template = await this.templatesService.getById(post.templateId);
    const schema = template.schemaJson as unknown as TemplateSchema;
    const field = schema.fields.find((f) => f.key === fieldKey);

    if (!field) throw new Error(`Поле "${fieldKey}" не найдено в шаблоне`);

    await this.redis.set(
      this.sessionKey(actorId),
      JSON.stringify({
        postId,
        channelId: post.channelId,
        templateId: post.templateId,
        step: 'EDIT_FIELD',
        fieldKey,
        expectedVersion: post.version,
      } as WizardSessionData),
      86400,
    );

    const currentVal = (post.contentJson as Record<string, unknown>)?.[fieldKey] ?? 'не заполнено';

    return {
      text:
        `✏️ <b>Редактирование поля «${field.label}»</b>\n\n` +
        `Текущее значение:\n<i>${String(currentVal).slice(0, 300)}</i>\n\n` +
        (field.hint ? `${field.hint}\n\n` : '') +
        `Введите новое значение:`,
      field,
    };
  }

  /**
   * Submits new value for a granularly edited field under OCC.
   */
  async submitEditedField(
    actorId: string,
    rawInput: string,
    entities?: MessageEntity[],
  ): Promise<{ success: boolean; text: string; post?: PostWithRelations }> {
    const rawSession = await this.redis.get(this.sessionKey(actorId));
    if (!rawSession) return { success: false, text: 'Сессия редактирования истекла.' };

    const session = JSON.parse(rawSession) as WizardSessionData;
    if (session.step !== 'EDIT_FIELD' || !session.postId || !session.fieldKey) {
      return { success: false, text: 'Неверный шаг редактирования.' };
    }

    const post = await this.postsRepository.findById(session.postId);
    if (!post) return { success: false, text: 'Пост не найден.' };

    const template = await this.templatesService.getById(session.templateId!);
    const schema = template.schemaJson as unknown as TemplateSchema;
    const field = schema.fields.find((f) => f.key === session.fieldKey);
    if (!field) return { success: false, text: 'Поле не найдено.' };

    let inputToValidate: unknown = rawInput;
    if (field.type === 'rich_text') {
      const formatted = entitiesToHtml(rawInput, entities);
      inputToValidate = this.htmlSanitizer.sanitize(formatted);
    }

    const valError = this.validator.validateField(field, inputToValidate);
    if (valError) {
      return {
        success: false,
        text: `⚠️ Ошибка проверки: ${valError.message}\nПопробуйте ещё раз:`,
      };
    }

    const { value: coerced } = this.validator.coerceFieldValue(field, inputToValidate);

    await this.postsService.autosaveStep(
      session.postId,
      session.expectedVersion ?? post.version,
      actorId,
      session.fieldKey,
      coerced,
    );

    await this.redis.del(this.sessionKey(actorId));

    const updated = (await this.postsRepository.findById(session.postId)) as PostWithRelations;

    return {
      success: true,
      text: `✅ Поле «${field.label}» успешно обновлено!`,
      post: updated,
    };
  }

  /**
   * Retrieves a draft by ID.
   */
  async getDraft(postId: string): Promise<Post | null> {
    return this.postsRepository.findById(postId);
  }

  /**
   * Soft-deletes draft with optimistic concurrency control check.
   */
  async deleteDraft(actorId: string, postId: string, expectedVersion: number): Promise<Post> {
    return this.postsService.softDeletePost(postId, expectedVersion, actorId);
  }
}
