import { SystemRole } from '@prisma/client';

export class UpdateUserDto {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  systemRole?: SystemRole;
  isActive?: boolean;
}
