import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PermissionService } from './permission.service';
import { AuthGuard } from './auth.guard';
import { RoleGuard } from './role.guard';
import { UsersModule } from '../users/users.module';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [UsersModule, PrismaModule, AuditModule],
  providers: [AuthService, PermissionService, AuthGuard, RoleGuard],
  exports: [AuthService, PermissionService, AuthGuard, RoleGuard],
})
export class AuthModule {}
