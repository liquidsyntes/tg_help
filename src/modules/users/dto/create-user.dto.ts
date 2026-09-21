import { SystemRole } from '@prisma/client';

export class CreateUserDto {
  telegramId: bigint | number | string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  systemRole?: SystemRole;
  isActive?: boolean;
}
