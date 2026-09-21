import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionService } from './permission.service';
import { SystemRole } from '../../common/enums';
import { PermissionDeniedException } from '../../common/exceptions/domain.exceptions';

export const ROLES_KEY = 'roles';

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionService: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<SystemRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new PermissionDeniedException('NO_AUTHENTICATED_USER');
    }

    if (user.systemRole === SystemRole.SUPER_ADMIN) {
      return true;
    }

    const hasRole = requiredRoles.includes(user.systemRole);
    if (!hasRole) {
      throw new PermissionDeniedException(`REQUIRED_ROLES_${requiredRoles.join(',')}`);
    }

    return true;
  }
}
