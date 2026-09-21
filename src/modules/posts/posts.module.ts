import { Module, forwardRef } from '@nestjs/common';
import { PostsRepository } from './posts.repository';
import { PostsService } from './posts.service';
import { PostWorkflowService } from './post-workflow.service';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notification.module';
import { AuthModule } from '../auth/auth.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { ChannelsModule } from '../channels/channels.module';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    NotificationsModule,
    AuthModule,
    ReviewsModule,
    ChannelsModule,
    forwardRef(() => MediaModule),
  ],
  providers: [PostsRepository, PostsService, PostWorkflowService],
  exports: [PostsRepository, PostsService, PostWorkflowService],
})
export class PostsModule {}
