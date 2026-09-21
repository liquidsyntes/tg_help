import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UnauthorizedUserException } from '../../common/exceptions/domain.exceptions';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const rawTelegramId =
      request.headers?.['x-telegram-user-id'] ||
      request.body?.telegramId ||
      request.query?.telegramId;

    if (!rawTelegramId) {
      throw new UnauthorizedUserException('Missing Telegram ID');
    }

    const authUser = await this.authService.authenticate(rawTelegramId);
    request.user = authUser;
    return true;
  }
}
