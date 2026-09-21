/**
 * Core Domain Enums
 * Authoritative reference: AGENTS.md § 9, § 10, tasks.md § 4, § 6, § 13
 */

export {
  SystemRole,
  ChannelRole,
  PostStatus,
  MediaType,
  ReviewAction,
  PublicationJobStatus,
} from '@prisma/client';


export enum PostAction {
  SUBMIT_FOR_REVIEW = 'SUBMIT_FOR_REVIEW',
  APPROVE = 'APPROVE',
  REQUEST_REVISION = 'REQUEST_REVISION',
  REJECT = 'REJECT',
  SCHEDULE = 'SCHEDULE',
  START_PUBLISHING = 'START_PUBLISHING',
  MARK_PUBLISHED = 'MARK_PUBLISHED',
  MARK_PUBLISH_FAILED = 'MARK_PUBLISH_FAILED',
  CANCEL = 'CANCEL',
}

export enum ChannelPermission {
  CREATE_POST = 'CREATE_POST',
  EDIT_POST = 'EDIT_POST',
  SUBMIT_REVIEW = 'SUBMIT_REVIEW',
  APPROVE_POST = 'APPROVE_POST',
  REJECT_POST = 'REJECT_POST',
  REQUEST_REVISION = 'REQUEST_REVISION',
  PUBLISH_POST = 'PUBLISH_POST',
  SCHEDULE_POST = 'SCHEDULE_POST',
  CANCEL_SCHEDULE = 'CANCEL_SCHEDULE',
  DELETE_POST = 'DELETE_POST',
  VIEW_POST = 'VIEW_POST',
}

export enum SystemPermission {
  MANAGE_USERS = 'MANAGE_USERS',
  MANAGE_CHANNELS = 'MANAGE_CHANNELS',
  MANAGE_TEMPLATES = 'MANAGE_TEMPLATES',
  VIEW_AUDIT_LOG = 'VIEW_AUDIT_LOG',
}

export enum AuditAction {
  POST_CREATED = 'post_created',
  POST_UPDATED = 'post_updated',
  POST_DELETED = 'post_deleted',
  MEDIA_ADDED = 'media_added',
  MEDIA_REMOVED = 'media_removed',
  SUBMITTED = 'submitted',
  SUBMITTED_FOR_REVIEW = 'submitted_for_review',
  APPROVED = 'approved',
  REVISION_REQUESTED = 'revision_requested',
  REJECTED = 'rejected',
  SCHEDULED = 'scheduled',
  SCHEDULE_CANCELLED = 'schedule_cancelled',
  PUBLICATION_STARTED = 'publication_started',
  PUBLICATION_ATTEMPT_FAILED = 'publication_attempt_failed',
  PUBLISHED = 'published',
  PUBLICATION_FAILED = 'publication_failed',
  PUBLISH_FAILED = 'publication_failed',
  PUBLICATION_CANCELLED = 'publication_cancelled',
  PUBLICATION_JOB_CREATED = 'publication_job_created',
  USER_ADDED = 'user_added',
  USER_BLOCKED = 'user_blocked',
  USER_REACTIVATED = 'user_reactivated',
  PERMISSION_CHANGED = 'permission_changed',
  SETTINGS_CHANGED = 'settings_changed',
  TEMPLATE_CHANGED = 'template_changed',
}

