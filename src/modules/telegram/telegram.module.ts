/**
 * Telegram Transport Module
 * Bundles grammY bot lifecycle, auth middleware, exception filter, wizard UI, and webhooks.
 * Authoritative reference: AGENTS.md § 3, § 4, § 5; tasks.md § 28, § 29
 */

import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../infrastructure/config/config.module';
import { LoggerModule } from '../../infrastructure/logger/logger.module';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { RedisModule } from '../../infrastructure/redis/redis.module';
import { AuthModule } from '../auth/auth.module';
import { ChannelsModule } from '../channels/channels.module';
import { PostsModule } from '../posts/posts.module';
import { TemplatesModule } from '../templates/templates.module';
import { RenderingModule } from '../rendering/rendering.module';
import { MediaModule } from '../media/media.module';
import { PublishingModule } from '../publishing/publishing.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { TelegramApiModule } from '../../infrastructure/telegram-api/telegram-api.module';

import { TelegramWebhookController } from './controllers/telegram-webhook.controller';
import { TelegramWebhookGuard } from './guards/telegram-webhook.guard';
import { TelegramRequestIdMiddleware } from './middlewares/telegram-request-id.middleware';
import { TelegramAuthMiddleware } from './middlewares/telegram-auth.middleware';
import { TelegramExceptionFilter } from './filters/telegram-exception.filter';

import { TelegramPreviewService } from './services/telegram-preview.service';
import { PostWizardService } from './services/post-wizard.service';
import { DraftManagerService } from './services/draft-manager.service';
import { ReviewQueueService } from './services/review-queue.service';

import { StartHandler } from './handlers/start.handler';
import { HelpHandler } from './handlers/help.handler';
import { PostWizardHandler } from './handlers/post-wizard.handler';
import { DraftManagerHandler } from './handlers/draft-manager.handler';
import { ReviewQueueHandler } from './handlers/review-queue.handler';
import { PostActionsHandler } from './handlers/post-actions.handler';

import { TelegramBotService } from './telegram-bot.service';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    PrismaModule,
    RedisModule,
    AuthModule,
    ChannelsModule,
    PostsModule,
    TemplatesModule,
    RenderingModule,
    MediaModule,
    PublishingModule,
    SchedulingModule,
    TelegramApiModule,
  ],
  controllers: [TelegramWebhookController],
  providers: [
    TelegramWebhookGuard,
    TelegramRequestIdMiddleware,
    TelegramAuthMiddleware,
    TelegramExceptionFilter,
    TelegramPreviewService,
    PostWizardService,
    DraftManagerService,
    ReviewQueueService,
    StartHandler,
    HelpHandler,
    PostWizardHandler,
    DraftManagerHandler,
    ReviewQueueHandler,
    PostActionsHandler,
    TelegramBotService,
  ],
  exports: [
    TelegramBotService,
    TelegramPreviewService,
    TelegramAuthMiddleware,
    TelegramExceptionFilter,
    PostWizardService,
    DraftManagerService,
    ReviewQueueService,
  ],
})
export class TelegramModule {}
