import { Injectable } from '@nestjs/common';
import { User, SystemRole } from '@prisma/client';
import { UsersRepository } from './users.repository';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AuditAction } from '../../common/enums';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly auditService: AuditService,
  ) {}

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findById(id);
  }

  async findByTelegramId(telegramId: bigint | number | string): Promise<User | null> {
    const parsedId = typeof telegramId === 'bigint' ? telegramId : BigInt(telegramId);
    return this.usersRepository.findByTelegramId(parsedId);
  }

  async createUser(dto: CreateUserDto, actorId?: string): Promise<User> {
    const telegramId = typeof dto.telegramId === 'bigint' ? dto.telegramId : BigInt(dto.telegramId);

    const user = await this.usersRepository.create({
      telegramId,
      username: dto.username ?? null,
      firstName: dto.firstName ?? null,
      lastName: dto.lastName ?? null,
      systemRole: dto.systemRole ?? SystemRole.USER,
      isActive: dto.isActive ?? true,
    });

    await this.auditService.record({
      action: AuditAction.USER_ADDED,
      entityType: 'user',
      entityId: user.id,
      actorId: actorId ?? null,
      payload: {
        telegramId: telegramId.toString(),
        username: user.username,
        systemRole: user.systemRole,
      },
    });

    return user;
  }

  async updateUser(id: string, dto: UpdateUserDto, actorId?: string): Promise<User> {
    const user = await this.usersRepository.update(id, {
      ...(dto.username !== undefined ? { username: dto.username } : {}),
      ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
      ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
      ...(dto.systemRole !== undefined ? { systemRole: dto.systemRole } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    });

    await this.auditService.record({
      action: AuditAction.SETTINGS_CHANGED,
      entityType: 'user',
      entityId: user.id,
      actorId: actorId ?? null,
      payload: { ...dto },
    });

    return user;
  }

  async deactivateUser(id: string, actorId?: string): Promise<User> {
    const user = await this.usersRepository.update(id, { isActive: false });

    await this.auditService.record({
      action: AuditAction.USER_BLOCKED,
      entityType: 'user',
      entityId: user.id,
      actorId: actorId ?? null,
      payload: { isActive: false },
    });

    return user;
  }

  async reactivateUser(id: string, actorId?: string): Promise<User> {
    const user = await this.usersRepository.update(id, { isActive: true });

    await this.auditService.record({
      action: AuditAction.USER_REACTIVATED,
      entityType: 'user',
      entityId: user.id,
      actorId: actorId ?? null,
      payload: { isActive: true },
    });

    return user;
  }

  async listUsers(params?: { skip?: number; take?: number }): Promise<{ items: User[]; total: number }> {
    const [items, total] = await Promise.all([
      this.usersRepository.findMany({ skip: params?.skip, take: params?.take }),
      this.usersRepository.count(),
    ]);
    return { items, total };
  }
}
