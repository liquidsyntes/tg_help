import { Module } from '@nestjs/common';
import { AppConfigModule } from './infrastructure/config/config.module';
import { LoggerModule } from './infrastructure/logger/logger.module';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { QueueModule } from './infrastructure/queues/queue.module';
import { HealthModule } from './modules/health/health.module';
import { AuditModule } from './modules/audit/audit.module';
import { NotificationsModule } from './modules/notifications/notification.module';
import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { PostsModule } from './modules/posts/posts.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { RenderingModule } from './modules/rendering/rendering.module';
import { MediaModule } from './modules/media/media.module';
import { TelegramApiModule } from './infrastructure/telegram-api/telegram-api.module';
import { PublishingModule } from './modules/publishing/publishing.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    HealthModule,
    AuditModule,
    NotificationsModule,
    UsersModule,
    AuthModule,
    ChannelsModule,
    ReviewsModule,
    PostsModule,
    TemplatesModule,
    RenderingModule,
    MediaModule,
    TelegramApiModule,
    PublishingModule,
    SchedulingModule,
  ],
})
export class AppModule {}

