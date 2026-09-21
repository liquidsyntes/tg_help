/**
 * MockTelegramPublisher
 * Implements ITelegramPublisher for hermetic CI/CD testing without real Telegram tokens.
 * Authoritative Sources: PROJECT.md § Interface Contracts; AGENTS.md §16, §17, §18, §22, §23, §48, §49, §50.
 */

export interface OutgoingMedia {
  type: 'photo' | 'video' | 'document' | 'animation';
  fileId: string;
  caption?: string;
}

export interface SendOptions {
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

export interface OutgoingMessagePart {
  partIndex?: number;
  type: 'text' | 'photo' | 'video' | 'document' | 'animation' | 'media_group';
  text?: string;
  html?: string;
  fileId?: string;
  caption?: string;
  fileName?: string;
  mimeType?: string;
  items?: OutgoingMediaGroupItem[];
  disableWebPagePreview?: boolean;
}

export const TelegramErrorCategory = {
  RATE_LIMITED: 'RATE_LIMITED',
  RETRYABLE: 'RETRYABLE',
  PERMANENT: 'PERMANENT',
} as const;

export type TelegramErrorCategory =
  (typeof TelegramErrorCategory)[keyof typeof TelegramErrorCategory];

export interface RecordedTelegramMessage {
  messageId: number;
  chatId: string;
  type: 'text' | 'photo' | 'video' | 'document' | 'animation' | 'media_group';
  text?: string;
  fileId?: string;
  caption?: string;
  media?: (OutgoingMedia | OutgoingMediaGroupItem)[];
  options?: SendOptions | SendMediaOptions | SendDocumentOptions;
  sentAt: Date;
}

export class TelegramApiError extends Error {
  public readonly statusCode: number;
  public readonly retryAfter?: number;
  public readonly isPermanent: boolean;

  constructor(
    message: string,
    statusCode: number,
    retryAfter?: number,
    isPermanent = false,
  ) {
    super(message);
    this.name = 'TelegramApiError';
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
    this.isPermanent = isPermanent;
  }
}

export const TELEGRAM_LIMITS = {
  MAX_MESSAGE_LENGTH: 4096,
  MAX_CAPTION_LENGTH: 1024,
  MIN_MEDIA_GROUP_SIZE: 2,
  MAX_MEDIA_GROUP_SIZE: 10,
} as const;

export class MockTelegramPublisher {
  private currentMessageId = 1000;
  private sentMessages: RecordedTelegramMessage[] = [];

  // Failure simulation configuration
  private transientFailuresRemaining = 0;
  private transientFailureError: Error | null = null;
  private rateLimitRemaining = 0;
  private rateLimitRetryAfter = 5;
  private permanentFailure: Error | null = null;

  private normalizeChatId(chatId: string | bigint): string {
    const s = typeof chatId === 'bigint' ? chatId.toString() : String(chatId).trim();
    if (!s) {
      throw new TelegramApiError('Bad Request: chat_id is empty', 400, undefined, true);
    }
    return s;
  }

  /**
   * Simulates sendMediaGroup Telegram API call.
   * Enforces Telegram limits: media group size must be 2..10.
   */
  async sendMediaGroup(
    chatId: string | bigint,
    media: (OutgoingMedia | OutgoingMediaGroupItem)[],
  ): Promise<number[]> {
    this.checkSimulatedFailures();
    const targetChat = this.normalizeChatId(chatId);

    if (!Array.isArray(media) || media.length < TELEGRAM_LIMITS.MIN_MEDIA_GROUP_SIZE || media.length > TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE) {
      throw new TelegramApiError(
        `Bad Request: media group must contain between ${TELEGRAM_LIMITS.MIN_MEDIA_GROUP_SIZE} and ${TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE} items (got ${media?.length})`,
        400,
        undefined,
        true,
      );
    }

    // Verify captions do not exceed MAX_CAPTION_LENGTH
    for (const item of media) {
      if (item.caption && item.caption.length > TELEGRAM_LIMITS.MAX_CAPTION_LENGTH) {
        throw new TelegramApiError(
          `Bad Request: media caption exceeds ${TELEGRAM_LIMITS.MAX_CAPTION_LENGTH} characters (got ${item.caption.length})`,
          400,
          undefined,
          true,
        );
      }
    }

    const assignedIds: number[] = [];
    for (let i = 0; i < media.length; i++) {
      this.currentMessageId += 1;
      assignedIds.push(this.currentMessageId);
    }

    this.sentMessages.push({
      messageId: assignedIds[0],
      chatId: targetChat,
      type: 'media_group',
      media,
      sentAt: new Date(),
    });

    return assignedIds;
  }

  /**
   * Simulates sendMessage Telegram API call.
   * Enforces Telegram limits: text length <= 4096.
   */
  async sendMessage(
    chatId: string | bigint,
    text: string,
    options?: SendOptions,
  ): Promise<number> {
    this.checkSimulatedFailures();
    const targetChat = this.normalizeChatId(chatId);

    if (!text || text.trim() === '') {
      throw new TelegramApiError('Bad Request: message text is empty', 400, undefined, true);
    }

    if (text.length > TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH) {
      throw new TelegramApiError(
        `Bad Request: message text exceeds ${TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH} characters (got ${text.length})`,
        400,
        undefined,
        true,
      );
    }

    this.currentMessageId += 1;
    const msgId = this.currentMessageId;

    this.sentMessages.push({
      messageId: msgId,
      chatId: targetChat,
      type: 'text',
      text,
      options,
      sentAt: new Date(),
    });

    return msgId;
  }

  async sendPhoto(
    chatId: string | bigint,
    photoFileId: string,
    options?: SendMediaOptions,
  ): Promise<number> {
    this.checkSimulatedFailures();
    const targetChat = this.normalizeChatId(chatId);
    this.validateCaption(options?.caption);

    this.currentMessageId += 1;
    const msgId = this.currentMessageId;

    this.sentMessages.push({
      messageId: msgId,
      chatId: targetChat,
      type: 'photo',
      fileId: photoFileId,
      caption: options?.caption,
      options,
      sentAt: new Date(),
    });

    return msgId;
  }

  async sendVideo(
    chatId: string | bigint,
    videoFileId: string,
    options?: SendMediaOptions,
  ): Promise<number> {
    this.checkSimulatedFailures();
    const targetChat = this.normalizeChatId(chatId);
    this.validateCaption(options?.caption);

    this.currentMessageId += 1;
    const msgId = this.currentMessageId;

    this.sentMessages.push({
      messageId: msgId,
      chatId: targetChat,
      type: 'video',
      fileId: videoFileId,
      caption: options?.caption,
      options,
      sentAt: new Date(),
    });

    return msgId;
  }

  async sendDocument(
    chatId: string | bigint,
    documentFileId: string,
    options?: SendDocumentOptions,
  ): Promise<number> {
    this.checkSimulatedFailures();
    const targetChat = this.normalizeChatId(chatId);
    this.validateCaption(options?.caption);

    this.currentMessageId += 1;
    const msgId = this.currentMessageId;

    this.sentMessages.push({
      messageId: msgId,
      chatId: targetChat,
      type: 'document',
      fileId: documentFileId,
      caption: options?.caption,
      options,
      sentAt: new Date(),
    });

    return msgId;
  }

  async sendAnimation(
    chatId: string | bigint,
    animationFileId: string,
    options?: SendMediaOptions,
  ): Promise<number> {
    this.checkSimulatedFailures();
    const targetChat = this.normalizeChatId(chatId);
    this.validateCaption(options?.caption);

    this.currentMessageId += 1;
    const msgId = this.currentMessageId;

    this.sentMessages.push({
      messageId: msgId,
      chatId: targetChat,
      type: 'animation',
      fileId: animationFileId,
      caption: options?.caption,
      options,
      sentAt: new Date(),
    });

    return msgId;
  }

  async publishOutgoingMessage(
    chatId: string | bigint,
    message: OutgoingMessagePart,
  ): Promise<number[]> {
    switch (message.type) {
      case 'text': {
        const textContent = message.html || message.text || '';
        const id = await this.sendMessage(chatId, textContent, {
          parseMode: 'HTML',
          disableWebPagePreview: message.disableWebPagePreview,
        });
        return [id];
      }
      case 'photo': {
        const id = await this.sendPhoto(chatId, message.fileId!, {
          caption: message.caption,
          parseMode: 'HTML',
        });
        return [id];
      }
      case 'video': {
        const id = await this.sendVideo(chatId, message.fileId!, {
          caption: message.caption,
          parseMode: 'HTML',
        });
        return [id];
      }
      case 'document': {
        const id = await this.sendDocument(chatId, message.fileId!, {
          caption: message.caption,
          fileName: message.fileName,
          mimeType: message.mimeType,
          parseMode: 'HTML',
        });
        return [id];
      }
      case 'animation': {
        const id = await this.sendAnimation(chatId, message.fileId!, {
          caption: message.caption,
          parseMode: 'HTML',
        });
        return [id];
      }
      case 'media_group': {
        const items = (message.items || []).map((i) => ({
          type: i.type,
          fileId: i.fileId,
          caption: i.caption,
        }));
        return this.sendMediaGroup(chatId, items);
      }
      default:
        throw new TelegramApiError(
          `Unsupported message type: ${(message as { type: string }).type}`,
          400,
          undefined,
          true,
        );
    }
  }

  categorizeError(error: unknown): TelegramErrorCategory {
    if (error instanceof TelegramApiError) {
      if (error.isPermanent) return TelegramErrorCategory.PERMANENT;
      if (error.statusCode === 429) return TelegramErrorCategory.RATE_LIMITED;
      if (error.statusCode >= 500 && error.statusCode < 600) return TelegramErrorCategory.RETRYABLE;
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (/429|too many requests|retry after/i.test(msg)) {
      return TelegramErrorCategory.RATE_LIMITED;
    }
    if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|connect timeout|network timeout|fetch failed|socket hang up/i.test(msg)) {
      return TelegramErrorCategory.RETRYABLE;
    }
    return TelegramErrorCategory.PERMANENT;
  }

  /**
   * Determines if an error is retryable (429 rate limit or 5xx server error).
   * Authoritative source: AGENTS.md §49, §50; PROJECT.md § Interface Contracts
   */
  isRetryable(error: unknown): boolean {
    if (error instanceof TelegramApiError) {
      if (error.isPermanent) return false;
      if (error.statusCode === 429) return true;
      if (error.statusCode >= 500 && error.statusCode < 600) return true;
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('connect timeout') ||
      msg.includes('network timeout') ||
      msg.includes('fetch failed') ||
      msg.includes('socket hang up') ||
      /429|too many requests/i.test(msg)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Extracts retry delay in seconds if specified (e.g. from 429 Retry-After).
   */
  getRetryDelay(error: unknown): number | null {
    if (error instanceof TelegramApiError && error.retryAfter !== undefined) {
      return error.retryAfter;
    }
    const msg = error instanceof Error ? error.message : String(error);
    const match = msg.match(/retry(?:_after| after)[:\s]+(\d+)/i);
    if (match && match[1]) {
      const sec = parseInt(match[1], 10);
      return Number.isNaN(sec) ? null : sec;
    }
    return null;
  }

  // --- Test Simulation Helpers ---

  simulateTransientFailures(count: number, error?: Error): void {
    this.transientFailuresRemaining = count;
    this.transientFailureError = error || new TelegramApiError('Internal Server Error (Simulated 500)', 500);
  }

  simulateRateLimit(count: number, retryAfterSeconds = 2): void {
    this.rateLimitRemaining = count;
    this.rateLimitRetryAfter = retryAfterSeconds;
  }

  simulatePermanentFailure(error: Error): void {
    this.permanentFailure = error;
  }

  resetFailures(): void {
    this.transientFailuresRemaining = 0;
    this.transientFailureError = null;
    this.rateLimitRemaining = 0;
    this.permanentFailure = null;
  }

  getSentMessages(chatId?: string): RecordedTelegramMessage[] {
    if (chatId) {
      return this.sentMessages.filter((m) => m.chatId === chatId);
    }
    return [...this.sentMessages];
  }

  getLastMessage(): RecordedTelegramMessage | undefined {
    return this.sentMessages[this.sentMessages.length - 1];
  }

  clear(): void {
    this.sentMessages = [];
    this.resetFailures();
  }

  private validateCaption(caption?: string): void {
    if (caption && caption.length > TELEGRAM_LIMITS.MAX_CAPTION_LENGTH) {
      throw new TelegramApiError(
        `Bad Request: media caption exceeds ${TELEGRAM_LIMITS.MAX_CAPTION_LENGTH} characters (got ${caption.length})`,
        400,
        undefined,
        true,
      );
    }
  }

  private checkSimulatedFailures(): void {
    if (this.permanentFailure) {
      throw this.permanentFailure;
    }

    if (this.rateLimitRemaining > 0) {
      this.rateLimitRemaining -= 1;
      throw new TelegramApiError(
        `Too Many Requests: retry after ${this.rateLimitRetryAfter}`,
        429,
        this.rateLimitRetryAfter,
      );
    }

    if (this.transientFailuresRemaining > 0) {
      this.transientFailuresRemaining -= 1;
      throw this.transientFailureError || new TelegramApiError('Simulated Gateway Timeout', 504);
    }
  }
}
