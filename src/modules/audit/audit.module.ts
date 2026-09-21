import { Module } from '@nestjs/common';
import { AuditService, AuditLogService } from './audit.service';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { LoggerModule } from '../../infrastructure/logger/logger.module';

@Module({
  imports: [PrismaModule, LoggerModule],
  providers: [
    AuditService,
    {
      provide: 'AuditLogService',
      useExisting: AuditService,
    },
  ],
  exports: [AuditService, 'AuditLogService'],
})
export class AuditModule {}
