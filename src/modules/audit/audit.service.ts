import { Injectable } from '@nestjs/common';
import { Prisma, AuditLog } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import { CreateAuditLogDto } from './dto/create-audit-log.dto';
import { sanitizeAuditPayload } from './audit-payload.sanitizer';

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: StructuredLoggerService,
  ) {}

  /**
   * Appends an immutable audit log record.
   * Supports participating in an existing Prisma transaction.
   */
  async record(dto: CreateAuditLogDto, tx?: Prisma.TransactionClient): Promise<AuditLog> {
    const client = tx || this.prisma;
    const sanitized = (sanitizeAuditPayload(dto.payload ?? {}) as Prisma.InputJsonValue) ?? {};

    const entry = await client.auditLog.create({
      data: {
        action: dto.action,
        entityType: dto.entityType,
        entityId: dto.entityId,
        actorId: dto.actorId ?? null,
        payload: sanitized,
      },
    });

    this.logger.debug(
      {
        event: 'audit_log_recorded',
        auditId: entry.id,
        action: dto.action,
        entityType: dto.entityType,
        entityId: dto.entityId,
        actorId: dto.actorId,
      },
      'AuditService',
    );

    return entry;
  }

  /**
   * Retrieves all audit logs for a specific entity in chronological order.
   */
  async findByEntity(entityType: string, entityId: string): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Retrieves audit logs initiated by a specific actor.
   */
  async findByActor(actorId: string, limit = 50): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: { actorId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Retrieves the most recent audit logs across the system.
   */
  async findRecent(limit = 100): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}

export const AuditLogService = AuditService;
export type AuditLogService = AuditService;
