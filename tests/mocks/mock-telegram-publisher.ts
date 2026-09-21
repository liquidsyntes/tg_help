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

export interface RecordedTelegramMessage {
  messageId: number;
  chatId: string;
  type: 'text' | 'media_group';
  text?: string;
  media?: OutgoingMedia[];
  options?: SendOptions;
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
    isPermanent: boolean = false,
  ) {
    super(message);
    this.name = 'TelegramApiError';
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
    this.isPermanent = isPermanent;
  }
}

export class MockTelegramPublisher {
  private currentMessageId = 1000;
  private sentMessages: RecordedTelegramMessage[] = [];

  // Failure simulation configuration
  private transientFailuresRemaining = 0;
  private transientFailureError: Error | null = null;
  private rateLimitRemaining = 0;
  private rateLimitRetryAfter = 5;
  private permanentFailure: Error | null = null;

  /**
   * Simulates sendMediaGroup Telegram API call.
   * Enforces Telegram limits: media group size must be 2..10.
   */
  async sendMediaGroup(chatId: string, media: OutgoingMedia[]): Promise<number[]> {
    this.checkSimulatedFailures();

    if (!chatId || chatId.trim() === '') {
      throw new TelegramApiError('Bad Request: chat_id is empty', 400, undefined, true);
    }

    if (!Array.isArray(media) || media.length < 2 || media.length > 10) {
      throw new TelegramApiError(
        `Bad Request: media group must contain between 2 and 10 items (got ${media?.length})`,
        400,
        undefined,
        true,
      );
    }

    // Verify captions do not exceed 1024 chars
    for (const item of media) {
      if (item.caption && item.caption.length > 1024) {
        throw new TelegramApiError(
          `Bad Request: media caption exceeds 1024 characters (got ${item.caption.length})`,
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
      chatId,
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
  async sendMessage(chatId: string, text: string, options?: SendOptions): Promise<number> {
    this.checkSimulatedFailures();

    if (!chatId || chatId.trim() === '') {
      throw new TelegramApiError('Bad Request: chat_id is empty', 400, undefined, true);
    }

    if (!text || text.trim() === '') {
      throw new TelegramApiError('Bad Request: message text is empty', 400, undefined, true);
    }

    if (text.length > 4096) {
      throw new TelegramApiError(
        `Bad Request: message text exceeds 4096 characters (got ${text.length})`,
        400,
        undefined,
        true,
      );
    }

    this.currentMessageId += 1;
    const msgId = this.currentMessageId;

    this.sentMessages.push({
      messageId: msgId,
      chatId,
      type: 'text',
      text,
      options,
      sentAt: new Date(),
    });

    return msgId;
  }

  /**
   * Determines if an error is retryable (429 rate limit or 5xx server error).
   * Authoritative source: AGENTS.md §49, §50; PROJECT.md § Interface Contracts
   */
  isRetryable(error: Error): boolean {
    if (error instanceof TelegramApiError) {
      if (error.isPermanent) return false;
      if (error.statusCode === 429) return true;
      if (error.statusCode >= 500 && error.statusCode < 600) return true;
    }
    // Network errors (ECONNRESET, ETIMEDOUT) are retryable
    if (error.message.includes('ECONNRESET') || error.message.includes('ETIMEDOUT')) {
      return true;
    }
    return false;
  }

  /**
   * Extracts retry delay in seconds if specified (e.g. from 429 Retry-After).
   */
  getRetryDelay(error: Error): number | null {
    if (error instanceof TelegramApiError && error.retryAfter !== undefined) {
      return error.retryAfter;
    }
    return null;
  }

  // --- Test Simulation Helpers ---

  simulateTransientFailures(count: number, error?: Error): void {
    this.transientFailuresRemaining = count;
    this.transientFailureError = error || new TelegramApiError('Internal Server Error (Simulated 500)', 500);
  }

  simulateRateLimit(count: number, retryAfterSeconds: number = 2): void {
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
