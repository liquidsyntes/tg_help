/**
 * Telegram Bot Service
 * Manages grammY bot lifecycle, middleware pipeline, and dual transport execution.
 * Authoritative reference: AGENTS.md § 3, § 4, § 5, § 36; tasks.md § 28, § 29; PROJECT.md F-47
 */

import { Injectable, OnModuleInit, OnApplicationShutdown, Optional } from '@nestjs/common';
import { Bot } from 'grammy';
import { Update } from 'grammy/types';
import { run, RunnerHandle } from '@grammyjs/runner';
import { EnvironmentConfigService } from '../../infrastructure/config/environment-config.service';
import { TelegramMode } from '../../infrastructure/config/environment.variables';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import { BotContext } from './interfaces/bot-context.interface';
import { TelegramRequestIdMiddleware } from './middlewares/telegram-request-id.middleware';
import { TelegramAuthMiddleware } from './middlewares/telegram-auth.middleware';
import { TelegramExceptionFilter } from './filters/telegram-exception.filter';
import { StartHandler } from './handlers/start.handler';
import { HelpHandler } from './handlers/help.handler';
import { PostWizardHandler } from './handlers/post-wizard.handler';
import { DraftManagerHandler } from './handlers/draft-manager.handler';
import { ReviewQueueHandler } from './handlers/review-queue.handler';
import { PostActionsHandler } from './handlers/post-actions.handler';

import { TemplateManagerHandler } from './handlers/template-manager.handler';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnApplicationShutdown {
  private bot!: Bot<BotContext>;
  private runner?: RunnerHandle;

  constructor(
    private readonly config: EnvironmentConfigService,
    private readonly requestIdMiddleware: TelegramRequestIdMiddleware,
    private readonly authMiddleware: TelegramAuthMiddleware,
    private readonly exceptionFilter: TelegramExceptionFilter,
    private readonly startHandler: StartHandler,
    private readonly helpHandler: HelpHandler,
    private readonly wizardHandler: PostWizardHandler,
    private readonly draftManagerHandler: DraftManagerHandler,
    private readonly reviewQueueHandler: ReviewQueueHandler,
    private readonly postActionsHandler: PostActionsHandler,
    private readonly templateManagerHandler: TemplateManagerHandler,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {
    this.bot = new Bot<BotContext>(this.config.botToken);
  }

  getBotInstance(): Bot<BotContext> {
    return this.bot;
  }

  async onModuleInit(): Promise<void> {
    this.registerMiddlewares();
    this.registerHandlers();
    this.registerCatch();

    if (this.config.isTest) {
      this.logger?.log({
        event: 'telegram_bot_test_mode_active',
        message: 'Suppressed polling/webhook in test environment.',
      });
      return;
    }

    if (this.config.telegramMode === TelegramMode.WEBHOOK) {
      await this.initWebhook();
    } else {
      await this.initPolling();
    }
  }

  private registerMiddlewares(): void {
    this.bot.use(this.requestIdMiddleware.create());
    this.bot.use(this.exceptionFilter.create());
    this.bot.use(this.authMiddleware.create());
  }

  private registerCatch(): void {
    this.bot.catch(async (err) => {
      await this.exceptionFilter.handleError(err.error, err.ctx);
    });
  }

  private registerHandlers(): void {
    // 1. Commands & Main Menu Text Buttons
    this.bot.command('start', async (ctx) => this.startHandler.handle(ctx));
    this.bot.command('help', async (ctx) => this.helpHandler.handle(ctx));
    this.bot.hears('❓ Помощь', async (ctx) => this.helpHandler.handle(ctx));

    this.bot.command('newpost', async (ctx) => this.wizardHandler.handleStartWizard(ctx));
    this.bot.hears('➕ Создать пост', async (ctx) => this.wizardHandler.handleStartWizard(ctx));
    this.bot.hears('📑 Скопировать пост', async (ctx) => this.wizardHandler.handleStartCopyWizard(ctx));

    this.bot.command('drafts', async (ctx) => this.draftManagerHandler.handleListDrafts(ctx));
    this.bot.hears('📝 Мои материалы', async (ctx) => this.draftManagerHandler.handleListDrafts(ctx));
    this.bot.hears('📝 Материалы', async (ctx) => this.draftManagerHandler.handleListDrafts(ctx));

    this.bot.command('reviews', async (ctx) => this.reviewQueueHandler.handleOpenReviewQueue(ctx));
    this.bot.hears('✅ На согласовании', async (ctx) =>
      this.reviewQueueHandler.handleOpenReviewQueue(ctx),
    );

    this.bot.hears('📄 Шаблоны', async (ctx) => this.templateManagerHandler.handleListTemplates(ctx));

    // 2. Callback Queries
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;

      // Wizard callbacks
      if (data.startsWith('wiz:chan:')) {
        const channelId = data.replace('wiz:chan:', '');
        return this.wizardHandler.handleChannelSelect(ctx, channelId);
      }
      if (data.startsWith('wiz:tpl:')) {
        const templateId = data.replace('wiz:tpl:', '');
        return this.wizardHandler.handleTemplateSelect(ctx, templateId);
      }
      if (data.startsWith('wiz:skip:')) {
        const fieldKey = data.replace('wiz:skip:', '');
        return this.wizardHandler.handleSkipField(ctx, fieldKey);
      }
      if (data === 'wiz:done_media') {
        return this.wizardHandler.handleFinishMedia(ctx);
      }
      if (data === 'wiz:cancel') {
        return this.wizardHandler.handleCancelWizard(ctx);
      }

      // Template manager callbacks
      if (data === 'tpl:list') {
        return this.templateManagerHandler.handleListTemplates(ctx);
      }
      if (data.startsWith('tpl:view:')) {
        return this.templateManagerHandler.handleViewTemplate(ctx, data.split(':')[2]!);
      }
      if (data.startsWith('tpl:rename:')) {
        return this.templateManagerHandler.handlePromptRename(ctx, data.split(':')[2]!);
      }
      if (data.startsWith('tpl:desc:')) {
        return this.templateManagerHandler.handlePromptDesc(ctx, data.split(':')[2]!);
      }
      if (data.startsWith('tpl:layout:')) {
        return this.templateManagerHandler.handlePromptLayout(ctx, data.split(':')[2]!);
      }
      if (data.startsWith('tpl:prev:')) {
        return this.templateManagerHandler.handlePreview(ctx, data.split(':')[2]!);
      }
      if (data.startsWith('tpl:clone:')) {
        return this.templateManagerHandler.handlePromptClone(ctx, data.split(':')[2]!);
      }
      if (data.startsWith('tpl:del:')) {
        return this.templateManagerHandler.handleDelete(ctx, data.split(':')[2]!);
      }
      if (data.startsWith('tpl:fields:')) {
        return this.templateManagerHandler.handleListFields(ctx, data.split(':')[2]!);
      }
      if (data.startsWith('tpl:f_view:')) {
        const parts = data.split(':');
        return this.templateManagerHandler.handleViewField(ctx, parts[2]!, parseInt(parts[3]!, 10));
      }
      if (data.startsWith('tpl:f_ren:')) {
        const parts = data.split(':');
        return this.templateManagerHandler.handlePromptFieldRename(ctx, parts[2]!, parseInt(parts[3]!, 10));
      }
      if (data.startsWith('tpl:f_hint:')) {
        const parts = data.split(':');
        return this.templateManagerHandler.handlePromptFieldHint(ctx, parts[2]!, parseInt(parts[3]!, 10));
      }
      if (data.startsWith('tpl:f_max:')) {
        const parts = data.split(':');
        return this.templateManagerHandler.handlePromptFieldMax(ctx, parts[2]!, parseInt(parts[3]!, 10));
      }
      if (data.startsWith('tpl:f_min:')) {
        const parts = data.split(':');
        return this.templateManagerHandler.handlePromptFieldMin(ctx, parts[2]!, parseInt(parts[3]!, 10));
      }
      if (data.startsWith('tpl:f_type:')) {
        const parts = data.split(':');
        return this.templateManagerHandler.handleSetFieldType(ctx, parts[2]!, parseInt(parts[3]!, 10), parts[4]!);
      }
      if (data.startsWith('tpl:f_req:')) {
        const parts = data.split(':');
        return this.templateManagerHandler.handleToggleFieldReq(ctx, parts[2]!, parseInt(parts[3]!, 10));
      }
      if (data.startsWith('tpl:f_del:')) {
        const parts = data.split(':');
        return this.templateManagerHandler.handleDeleteField(ctx, parts[2]!, parseInt(parts[3]!, 10));
      }
      if (data.startsWith('tpl:f_add:')) {
        return this.templateManagerHandler.handlePromptAddField(ctx, data.split(':')[2]!);
      }

      // Draft manager callbacks
      if (data.startsWith('draft:res:')) {
        const postId = data.replace('draft:res:', '');
        return this.draftManagerHandler.handleResumeDraft(ctx, postId);
      }
      const delMatch = data.match(/^draft:del:([0-9a-fA-F-]+)(?::(\d+))?$/);
      if (delMatch) {
        const postId = delMatch[1]!;
        const versionStr = delMatch[2];
        return this.draftManagerHandler.handlePromptDeleteDraft(ctx, postId, versionStr);
      }
      if (data.startsWith('draft:del:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const versionStr = parts[3];
        return this.draftManagerHandler.handlePromptDeleteDraft(ctx, postId, versionStr);
      }
      if (data.startsWith('draft:cdel:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const versionStr = parts[3] ?? '1';
        return this.draftManagerHandler.handleConfirmDeleteDraft(ctx, postId, versionStr);
      }
      if (data.startsWith('d:e:') || data.startsWith('draft:edit:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const fieldKey = parts[3]!;
        return this.draftManagerHandler.handleEditFieldPrompt(ctx, postId, fieldKey);
      }

      // Review queue callbacks
      if (data.startsWith('q:card:')) {
        const parts = data.split(':');
        const indexStr = parts[3] ?? '0';
        return this.reviewQueueHandler.handleCardNavigation(ctx, indexStr);
      }
      if (data.startsWith('r:app:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.reviewQueueHandler.handleApprove(ctx, postId, version);
      }
      if (data.startsWith('r:rev:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.reviewQueueHandler.handleRequestRevisionPrompt(ctx, postId, version);
      }
      if (data.startsWith('r:rej:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.reviewQueueHandler.handleRejectPrompt(ctx, postId, version);
      }
      if (data.startsWith('r:rej_ok:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.reviewQueueHandler.handleConfirmReject(ctx, postId, version);
      }

      // Post action callbacks
      if (data.startsWith('p:sub:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.postActionsHandler.handleSubmitForReview(ctx, postId, version);
      }
      if (data.startsWith('p:del:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.postActionsHandler.handlePromptDeleteDraft(ctx, postId, version);
      }
      if (data.startsWith('p:del_ok:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.postActionsHandler.handleConfirmDeleteDraft(ctx, postId, version);
      }
      if (data.startsWith('p:view:')) {
        const postId = data.replace('p:view:', '');
        return this.postActionsHandler.handleViewPost(ctx, postId);
      }
      if (data.startsWith('p:edt:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        return this.postActionsHandler.handleEditPostMenu(ctx, postId);
      }
      if (data.startsWith('p:med:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.postActionsHandler.handleManageMedia(ctx, postId, version);
      }
      if (data.startsWith('p:madd:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.postActionsHandler.handleAddMedia(ctx, postId, version);
      }
      if (data.startsWith('p:mclr:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.postActionsHandler.handleClearMedia(ctx, postId, version);
      }

      // Publishing & Scheduling callbacks
      if (data.startsWith('pub:now:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.postActionsHandler.handlePublishNow(ctx, postId, version);
      }
      if (data.startsWith('pub:sch:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.postActionsHandler.handleSchedulePrompt(ctx, postId, version);
      }
      if (data.startsWith('pub:sch_c:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.postActionsHandler.handlePromptCancelSchedule(ctx, postId, version);
      }
      if (data.startsWith('pub:sch_ok:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.postActionsHandler.handleConfirmCancelSchedule(ctx, postId, version);
      }
      if (data.startsWith('pub:ret:')) {
        const parts = data.split(':');
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.postActionsHandler.handleRetryPublish(ctx, postId, version);
      }

      // Scheduling presets
      if (data.startsWith('sch_p:')) {
        const parts = data.split(':');
        const preset = parts[1]!;
        const postId = parts[2]!;
        const version = parseInt(parts[3]!, 10) || 1;
        return this.postActionsHandler.handleSchedulePreset(ctx, preset, postId, version);
      }

      // Navigation
      if (data === 'nav:main') {
        return this.postActionsHandler.handleNavMain(ctx);
      }

      await ctx.answerCallbackQuery();
    });

    // 3. Media Messages (photo, video, animation, document)
    this.bot.on(
      ['message:photo', 'message:video', 'message:animation', 'message:document'],
      async (ctx) => {
        await this.wizardHandler.handleMediaUpload(ctx);
      },
    );

    // 4. Fallback Text Messages
    this.bot.on('message:text', async (ctx) => {
      // Try conversational handlers in priority order
      const handledByTemplate = await this.templateManagerHandler.handleTextInput(ctx);
      if (handledByTemplate) return;

      const handledByReview = await this.reviewQueueHandler.handleTextInput(ctx);
      if (handledByReview) return;

      const handledBySchedule = await this.postActionsHandler.handleTextInput(ctx);
      if (handledBySchedule) return;

      const handledByDraftEdit = await this.draftManagerHandler.handleTextInput(ctx);
      if (handledByDraftEdit) return;

      const handledByWizard = await this.wizardHandler.handleTextInput(ctx);
      if (handledByWizard) return;
    });
  }

  private async initWebhook(): Promise<void> {
    const domain = this.config.webhookDomain;
    if (!domain) {
      this.logger?.warn({
        event: 'telegram_webhook_domain_missing',
        message: 'WEBHOOK_DOMAIN not provided; skipping setWebhook.',
      });
      return;
    }

    const webhookUrl = `${domain.replace(/\/$/, '')}${this.config.webhookPath}`;
    await this.bot.api.setWebhook(webhookUrl, {
      secret_token: this.config.webhookSecretToken,
      allowed_updates: ['message', 'callback_query'],
    });

    this.logger?.log({
      event: 'telegram_bot_started',
      mode: 'webhook',
      webhookUrl,
    });
  }

  private async initPolling(): Promise<void> {
    try {
      await this.bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch (err: unknown) {
      this.logger?.warn({
        event: 'telegram_delete_webhook_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.runner = run(this.bot);

    this.logger?.log({
      event: 'telegram_bot_started',
      mode: 'polling',
    });
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.runner?.isRunning()) {
      await this.runner.stop();
      this.logger?.log({ event: 'telegram_bot_polling_stopped', signal });
    }
  }

  async handleUpdate(update: unknown): Promise<void> {
    await this.bot.handleUpdate(update as Update);
  }
}
