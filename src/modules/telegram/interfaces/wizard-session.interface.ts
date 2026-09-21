/**
 * Wizard Session Data Interface
 * Ephemeral session pointers stored in Redis (user:session:{userId})
 * Authoritative reference: AGENTS.md § 11, § 12; tasks.md § 9, § 10
 */

export type WizardStep =
  | 'CHANNEL_SELECT'
  | 'TEMPLATE_SELECT'
  | 'FIELD_INPUT'
  | 'MEDIA_UPLOAD'
  | 'EDIT_FIELD';

export interface WizardSessionData {
  postId?: string;
  channelId?: string;
  templateId?: string;
  step: WizardStep;
  fieldIndex?: number;
  fieldKey?: string;
  expectedVersion?: number;
  mode?: 'CREATE' | 'EDIT';
}

export interface ReviewSessionData {
  state: 'AWAITING_REVISION_COMMENT';
  postId: string;
  expectedVersion: number;
}

export interface ScheduleSessionData {
  state: 'AWAITING_SCHEDULE_DATETIME';
  postId: string;
  expectedVersion: number;
  channelId: string;
}

export type ConversationalSessionData =
  | ({ type: 'WIZARD' } & WizardSessionData)
  | ({ type: 'REVISION' } & ReviewSessionData)
  | ({ type: 'SCHEDULE' } & ScheduleSessionData);
