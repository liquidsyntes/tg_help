/**
 * Post Wizard Application Service
 * Orchestrates step-by-step post creation with immediate PostgreSQL autosave.
 * Authoritative reference: AGENTS.md § 11, § 12, § 14; tasks.md § 9, § 10, § 14
 */

import { Injectable, Optional } from '@nestjs/common';
import { Channel, PostTemplate, Post, PostMedia } from '@prisma/client';
import { MessageEntity } from 'grammy/types';
import { PostsService } from '../../posts/posts.service';
import { PostsRepository } from '../../posts/posts.repository';
import { TemplatesService } from '../../templates/templates.service';
import { TemplateValidator } from '../../templates/template.validator';
import { ChannelsService } from '../../channels/channels.service';
import { MediaService } from '../../media/media.service';
import { RedisService } from '../../../infrastructure/redis/redis.service';
import { HtmlSanitizer } from '../../rendering/html-sanitizer.service';
import { StructuredLoggerService } from '../../../infrastructure/logger/structured-logger.service';
import {
  TemplateSchema,
  TemplateFieldDefinition,
} from '../../templates/interfaces/template.interface';
import { AttachMediaDto } from '../../media/dto/attach-media.dto';
import { WizardSessionData } from '../interfaces/wizard-session.interface';
import { PostWithRelations } from './telegram-preview.service';
import { entitiesToHtml } from '../utils/entity-converter.util';

export interface WizardPromptResult {
  type:
    | 'CHANNEL_SELECT'
    | 'TEMPLATE_SELECT'
    | 'FIELD_PROMPT'
    | 'MEDIA_PROMPT'
    | 'COMPLETED'
    | 'ERROR';
  text: string;
  channels?: Channel[];
  templates?: PostTemplate[];
  field?: TemplateFieldDefinition;
  post?: PostWithRelations;
}

@Injectable()
export class PostWizardService {
  private readonly albumTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly postsService: PostsService,
    private readonly postsRepository: PostsRepository,
    private readonly templatesService: TemplatesService,
    private readonly validator: TemplateValidator,
    private readonly channelsService: ChannelsService,
    private readonly mediaService: MediaService,
    private readonly redis: RedisService,
    private readonly htmlSanitizer: HtmlSanitizer,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {}

  private sessionKey(actorId: string): string {
    return `wizard:session:${actorId}`;
  }

  async getSession(actorId: string): Promise<WizardSessionData | null> {
    const raw = await this.redis.get(this.sessionKey(actorId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as WizardSessionData;
    } catch {
      return null;
    }
  }

  async saveSession(actorId: string, data: WizardSessionData): Promise<void> {
    await this.redis.set(this.sessionKey(actorId), JSON.stringify(data), 86400);
  }

  async clearSession(actorId: string): Promise<void> {
    await this.redis.del(this.sessionKey(actorId));
  }

  async cancelWizard(actorId: string): Promise<void> {
    await this.clearSession(actorId);
  }

  /**
   * Step 1: Channel selection or auto-skip.
   */
  async startWizard(actorId: string): Promise<WizardPromptResult> {
    const { singleChannel, channels, mustChoose } =
      await this.channelsService.autoSkipSingleChannel(actorId);

    if (channels.length === 0) {
      return {
        type: 'ERROR',
        text: '⚠️ У вас нет доступа ни к одному каналу для создания публикаций. Обратитесь к администратору.',
      };
    }

    if (singleChannel && !mustChoose) {
      // Auto-skip channel selection (F-05)
      await this.saveSession(actorId, {
        channelId: singleChannel.id,
        step: 'TEMPLATE_SELECT',
      });

      const templates = await this.templatesService.getActiveTemplates();
      return {
        type: 'TEMPLATE_SELECT',
        text:
          `📢 Канал выбран автоматически: <b>${singleChannel.title}</b>\n\n` +
          `📄 Выберите шаблон публикации:`,
        templates,
      };
    }

    // Multiple channels: prompt selection
    await this.saveSession(actorId, {
      step: 'CHANNEL_SELECT',
    });

    return {
      type: 'CHANNEL_SELECT',
      text: '📢 Выберите канал для публикации:',
      channels,
    };
  }

  /**
   * Channel chosen by author.
   */
  async selectChannel(actorId: string, channelId: string): Promise<WizardPromptResult> {
    await this.saveSession(actorId, {
      channelId,
      step: 'TEMPLATE_SELECT',
    });

    const templates = await this.templatesService.getActiveTemplates();
    return {
      type: 'TEMPLATE_SELECT',
      text: '📄 Выберите шаблон публикации:',
      templates,
    };
  }

  /**
   * Step 2: Template chosen -> immediately create draft in PostgreSQL.
   */
  async selectTemplate(actorId: string, templateId: string): Promise<WizardPromptResult> {
    let session = await this.getSession(actorId);
    let channelId = session?.channelId;

    if (!channelId) {
      const skip = await this.channelsService.autoSkipSingleChannel(actorId);
      if (skip.singleChannel) {
        channelId = skip.singleChannel.id;
      } else {
        return {
          type: 'ERROR',
          text: '⚠️ Канал не выбран. Пожалуйста, начните создание поста заново.',
        };
      }
    }

    const template = await this.templatesService.getById(templateId);

    // Immediate draft creation in PostgreSQL (status = DRAFT, version = 1)
    const post = await this.postsService.createDraft({
      authorId: actorId,
      channelId,
      templateId,
      templateVersion: template.version,
      contentJson: {},
      metadataJson: { wizardStep: 'field', currentFieldIndex: 0 },
    });

    const schema = template.schemaJson as unknown as TemplateSchema;
    const fields = schema?.fields || [];

    if (fields.length === 0) {
      if (template.supportedMediaTypes && template.supportedMediaTypes.length > 0) {
        await this.saveSession(actorId, {
          postId: post.id,
          channelId,
          templateId,
          step: 'MEDIA_UPLOAD',
          expectedVersion: post.version,
        });
        return {
          type: 'MEDIA_PROMPT',
          text:
            `Шаг 4: <b>Добавление медиа</b>\n\n` +
            `Вы можете отправить фото, видео, анимацию (GIF) или документ (до 10 файлов).\n\n` +
            `Если медиа не требуется, нажмите кнопку ниже:`,
        };
      }

      await this.clearSession(actorId);
      const fullPost = (await this.postsRepository.findById(post.id)) as PostWithRelations;
      return {
        type: 'COMPLETED',
        text: '✅ Черновик успешно создан!',
        post: fullPost,
      };
    }

    await this.saveSession(actorId, {
      postId: post.id,
      channelId,
      templateId,
      step: 'FIELD_INPUT',
      fieldIndex: 0,
      expectedVersion: post.version,
    });

    return this.renderFieldPrompt(fields[0]!, 0, fields.length);
  }

  /**
   * Step 3: Process text input for the current field.
   */
  async processFieldInput(
    actorId: string,
    rawInput: string,
    entities?: MessageEntity[],
  ): Promise<WizardPromptResult> {
    const session = await this.getSession(actorId);
    if (!session || session.step !== 'FIELD_INPUT' || !session.postId || !session.templateId) {
      return {
        type: 'ERROR',
        text: 'Сессия создания поста не найдена. Нажмите «➕ Создать пост», чтобы начать заново.',
      };
    }

    const post = await this.postsRepository.findById(session.postId);
    if (!post) {
      await this.clearSession(actorId);
      return {
        type: 'ERROR',
        text: 'Черновик не найден или был удалён.',
      };
    }

    const template = await this.templatesService.getById(session.templateId);
    const schema = template.schemaJson as unknown as TemplateSchema;
    const fields = schema?.fields || [];
    const fieldIndex = session.fieldIndex ?? 0;
    const currentField = fields[fieldIndex];

    if (!currentField) {
      return this.transitionToMediaOrCompletion(actorId, session, post, template);
    }

    let inputToValidate: unknown = rawInput;

    if (currentField.type === 'rich_text') {
      const formatted = entitiesToHtml(rawInput, entities);
      inputToValidate = this.htmlSanitizer.sanitize(formatted);
    }

    const validationError = this.validator.validateField(currentField, inputToValidate);
    if (validationError) {
      return {
        type: 'FIELD_PROMPT',
        text:
          `⚠️ <b>Ошибка проверки:</b>\n${validationError.message}\n\n` +
          `💡 <i>${currentField.hint || 'Пожалуйста, введите корректное значение:'}</i>`,
        field: currentField,
      };
    }

    const { value: coercedValue } = this.validator.coerceFieldValue(currentField, inputToValidate);

    // IMMEDIATE PostgreSQL Autosave (AGENTS.md §11, §12)
    const updatedPost = await this.postsService.autosaveStep(
      session.postId,
      post.version,
      actorId,
      currentField.key,
      coercedValue,
    );

    const nextIndex = fieldIndex + 1;
    if (nextIndex < fields.length) {
      await this.saveSession(actorId, {
        ...session,
        fieldIndex: nextIndex,
        expectedVersion: updatedPost.version,
      });
      return this.renderFieldPrompt(fields[nextIndex]!, nextIndex, fields.length);
    }

    return this.transitionToMediaOrCompletion(actorId, session, updatedPost, template);
  }

  /**
   * Skip optional field.
   */
  async skipField(actorId: string, fieldKey: string): Promise<WizardPromptResult> {
    const session = await this.getSession(actorId);
    if (!session || !session.postId || !session.templateId) {
      return {
        type: 'ERROR',
        text: 'Сессия не найдена.',
      };
    }

    const post = await this.postsRepository.findById(session.postId);
    if (!post) {
      await this.clearSession(actorId);
      return { type: 'ERROR', text: 'Черновик не найден.' };
    }

    const template = await this.templatesService.getById(session.templateId);
    const schema = template.schemaJson as unknown as TemplateSchema;
    const fields = schema?.fields || [];
    const fieldIndex = session.fieldIndex ?? 0;
    const currentField = fields[fieldIndex];

    if (currentField && currentField.required && currentField.key === fieldKey) {
      return {
        type: 'FIELD_PROMPT',
        text: `⚠️ Поле «${currentField.label}» обязательно для заполнения и не может быть пропущено.`,
        field: currentField,
      };
    }

    // Autosave null
    const updatedPost = await this.postsService.autosaveStep(
      session.postId,
      post.version,
      actorId,
      fieldKey,
      null,
    );

    const nextIndex = fieldIndex + 1;
    if (nextIndex < fields.length) {
      await this.saveSession(actorId, {
        ...session,
        fieldIndex: nextIndex,
        expectedVersion: updatedPost.version,
      });
      return this.renderFieldPrompt(fields[nextIndex]!, nextIndex, fields.length);
    }

    return this.transitionToMediaOrCompletion(actorId, session, updatedPost, template);
  }

  /**
   * Attach media uploaded by author.
   */
  async processMediaUpload(
    actorId: string,
    mediaDto: AttachMediaDto,
    mediaGroupId?: string,
    onBatchComplete?: (count: number) => Promise<void>,
  ): Promise<{ success: boolean; message: string; isBatch: boolean }> {
    const session = await this.getSession(actorId);
    if (!session || !session.postId) {
      return { success: false, message: 'Сессия не найдена.', isBatch: false };
    }

    const post = await this.postsRepository.findById(session.postId);
    if (!post) {
      return { success: false, message: 'Черновик не найден.', isBatch: false };
    }

    // Album Debouncing / Batch Collector Pattern
    if (mediaGroupId) {
      const bufferKey = `album:buf:${mediaGroupId}`;
      await this.redis.getClient().rpush(bufferKey, JSON.stringify(mediaDto));
      await this.redis.getClient().expire(bufferKey, 60);

      const existingTimer = this.albumTimers.get(mediaGroupId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      this.albumTimers.set(
        mediaGroupId,
        setTimeout(async () => {
          this.albumTimers.delete(mediaGroupId);
          try {
            const rawItems = await this.redis.getClient().lrange(bufferKey, 0, -1);
            await this.redis.del(bufferKey);

            if (!rawItems || rawItems.length === 0) return;

            const dtos: AttachMediaDto[] = rawItems.map((r) => JSON.parse(r) as AttachMediaDto);
            const freshPost = await this.postsRepository.findById(session.postId!);
            if (!freshPost) return;

            await this.mediaService.attachMediaBatch(
              session.postId!,
              freshPost.version,
              actorId,
              dtos,
            );

            if (onBatchComplete) {
              await onBatchComplete(dtos.length);
            }
          } catch (err: unknown) {
            this.logger?.error({
              event: 'album_debounce_failed',
              mediaGroupId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, 600),
      );

      return {
        success: true,
        message: '⏳ Медиафайлы группы загружаются...',
        isBatch: true,
      };
    }

    // Single media attachment
    await this.mediaService.attachMedia(session.postId, post.version, actorId, mediaDto);

    return {
      success: true,
      message: '✅ Медиафайл успешно прикреплен к публикации.',
      isBatch: false,
    };
  }

  /**
   * Finish media upload.
   */
  async finishMedia(actorId: string): Promise<WizardPromptResult> {
    const session = await this.getSession(actorId);
    if (!session || !session.postId) {
      return { type: 'ERROR', text: 'Сессия не найдена.' };
    }

    const post = (await this.postsRepository.findById(session.postId)) as PostWithRelations;
    if (!post) {
      await this.clearSession(actorId);
      return { type: 'ERROR', text: 'Черновик не найден.' };
    }

    // Check if template strictly requires media (e.g. photo or video)
    const templateKey = post.template.key.toLowerCase();
    if (
      (templateKey.includes('photo') || templateKey.includes('video')) &&
      (!post.media || post.media.length === 0)
    ) {
      return {
        type: 'MEDIA_PROMPT',
        text: `⚠️ Шаблон «${post.template.name}» требует обязательного прикрепления медиа. Пожалуйста, отправьте файл.`,
      };
    }

    await this.clearSession(actorId);

    return {
      type: 'COMPLETED',
      text: '✅ Публикация готова к предпросмотру!',
      post,
    };
  }

  private renderFieldPrompt(
    field: TemplateFieldDefinition,
    index: number,
    total: number,
  ): WizardPromptResult {
    const requiredBadge = field.required ? '🔴 Обязательное поле' : '⚪️ Необязательное поле';
    const limitInfo = field.maxLength ? ` (макс. ${field.maxLength} симв.)` : '';

    const text =
      `Шаг ${index + 1} из ${total}: <b>${field.label}</b>\n\n` +
      (field.hint ? `${field.hint}\n\n` : '') +
      `${requiredBadge}${limitInfo}\n\n` +
      `Введите значение:`;

    return {
      type: 'FIELD_PROMPT',
      text,
      field,
    };
  }

  private async transitionToMediaOrCompletion(
    actorId: string,
    session: WizardSessionData,
    post: Post,
    template: PostTemplate,
  ): Promise<WizardPromptResult> {
    if (template.supportedMediaTypes && template.supportedMediaTypes.length > 0) {
      await this.saveSession(actorId, {
        ...session,
        step: 'MEDIA_UPLOAD',
        expectedVersion: post.version,
      });

      return {
        type: 'MEDIA_PROMPT',
        text:
          `Шаг 4: <b>Добавление медиа</b>\n\n` +
          `Вы можете отправить фото, видео, анимацию (GIF) или документ (до 10 файлов).\n\n` +
          `Если медиа не требуется, нажмите «Завершить добавление медиа».`,
      };
    }

    await this.clearSession(actorId);
    const fullPost = (await this.postsRepository.findById(post.id)) as PostWithRelations;
    return {
      type: 'COMPLETED',
      text: '✅ Публикация готова к предпросмотру!',
      post: fullPost,
    };
  }
}
