import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PostsModule } from '../posts/posts.module';
import { MediaService } from './media.service';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    AuthModule,
    forwardRef(() => PostsModule),
  ],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
