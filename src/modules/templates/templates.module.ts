import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TemplateValidator } from './template.validator';
import { TemplatesService } from './templates.service';

@Module({
  imports: [PrismaModule, AuditModule, AuthModule],
  providers: [TemplateValidator, TemplatesService],
  exports: [TemplateValidator, TemplatesService],
})
export class TemplatesModule {}
