/**
 * Telegram Publisher Abstraction Interface
 * Authoritative reference: AGENTS.md § 16, § 17, § 18, § 48, § 49, § 50; tasks.md § 16, § 18
 */

import { TelegramOutgoingMessage } from '../../../modules/rendering/interfaces/telegram-payload.interface';

export const TELEGRAM_PUBLISHER = 'TELEGRAM_PUBLISHER';

export interface SendTextOptions {
  parseMode?: 'HTML';
  disableWebPagePreview?: boolean;
}

export interface SendMediaOptions {
  caption?: string;
  parseMode?: 'HTML';
}

export interface SendDocumentOptions extends SendMediaOptions {
  fileName?: string;
  mimeType?: string;
}

export interface OutgoingMediaGroupItem {
  type: 'photo' | 'video' | 'document';
  fileId: string;
  caption?: string;
}

export enum TelegramErrorCategory {
  RATE_LIMITED = 'RATE_LIMITED', // 429 Too Many Requests -> delay retry
  RETRYABLE = 'RETRYABLE',       // 5xx, network timeouts -> exponential backoff
  PERMANENT = 'PERMANENT',       // 400, 403 -> fail fast, abort retries
}

export interface ITelegramPublisher {
  /**
   * Sends a standard HTML text message.
   * Text length must be <= 4096 characters.
   */
  sendMessage(
    chatId: string | bigint,
    text: string,
    options?: SendTextOptions,
  ): Promise<number>;

  /**
   * Sends a photo by Telegram file_id.
   * Caption length must be <= 1024 characters.
   */
  sendPhoto(
    chatId: string | bigint,
    photoFileId: string,
    options?: SendMediaOptions,
  ): Promise<number>;

  /**
   * Sends a video by Telegram file_id.
   * Caption length must be <= 1024 characters.
   */
  sendVideo(
    chatId: string | bigint,
    videoFileId: string,
    options?: SendMediaOptions,
  ): Promise<number>;

  /**
   * Sends an uncompressed document by Telegram file_id.
   * Caption length must be <= 1024 characters.
   */
  sendDocument(
    chatId: string | bigint,
    documentFileId: string,
    options?: SendDocumentOptions,
  ): Promise<number>;

  /**
   * Sends an animation (GIF / H.264 without sound) by Telegram file_id.
   * Caption length must be <= 1024 characters.
   */
  sendAnimation(
    chatId: string | bigint,
    animationFileId: string,
    options?: SendMediaOptions,
  ): Promise<number>;

  /**
   * Sends a media group (album) containing 2 to 10 items.
   * Captions must be <= 1024 characters.
   * Returns array of message IDs for each item in the album.
   */
  sendMediaGroup(
    chatId: string | bigint,
    media: OutgoingMediaGroupItem[],
  ): Promise<number[]>;

  /**
   * Dispatches a single canonical TelegramOutgoingMessage part produced by TelegramRenderer.
   * Enables clean iteration and partial publishing resumption in the worker.
   */
  publishOutgoingMessage(
    chatId: string | bigint,
    message: TelegramOutgoingMessage,
  ): Promise<number[]>;

  /**
   * Classifies any error into RATE_LIMITED, RETRYABLE, or PERMANENT.
   */
  categorizeError(error: unknown): TelegramErrorCategory;

  /**
   * Returns true if error is retryable (429, 5xx, network timeout).
   */
  isRetryable(error: unknown): boolean;

  /**
   * Returns retry-after delay in seconds if error is 429 rate limit, else null.
   */
  getRetryDelay(error: unknown): number | null;
}
