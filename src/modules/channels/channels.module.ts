import { Module } from '@nestjs/common';
import { ChannelsService } from './channels.service';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
