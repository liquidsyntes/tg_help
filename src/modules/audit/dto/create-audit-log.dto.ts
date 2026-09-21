import { AuditAction } from '../../../common/enums';

export interface CreateAuditLogDto {
  action: AuditAction | string;
  entityType: 'post' | 'user' | 'channel' | 'publication_job' | 'template' | 'channel_member' | string;
  entityId: string;
  actorId?: string | null;
  payload?: Record<string, unknown> | null;
}
