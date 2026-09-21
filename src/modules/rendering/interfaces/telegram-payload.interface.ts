/**
 * Telegram publication payload interfaces.
 * Authoritative reference: AGENTS.md § 15, § 16, tasks.md § 15, § 16
 */

export type OutgoingMessageType =
  | 'text'
  | 'photo'
  | 'video'
  | 'document'
  | 'animation'
  | 'media_group';

export interface MediaGroupItem {
  type: 'photo' | 'video' | 'document';
  fileId: string;
  caption?: string;
}

export interface TelegramOutgoingMessage {
  /** 0-based sequence index for worker tracking & partial publishing resume */
  partIndex: number;
  type: OutgoingMessageType;
  text?: string;
  html?: string;
  fileId?: string;
  caption?: string;
  fileName?: string;
  mimeType?: string;
  items?: MediaGroupItem[];
  disableWebPagePreview?: boolean;
}

export interface TelegramPayload {
  messages: TelegramOutgoingMessage[];
}
