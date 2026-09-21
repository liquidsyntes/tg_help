/**
 * Centralized Telegram API limits and constraints.
 * Authoritative reference: AGENTS.md § 18, tasks.md § 16, § 18
 */
export const TELEGRAM_LIMITS = {
  /** Maximum length of a standard text message in characters */
  MAX_MESSAGE_LENGTH: 4096,

  /** Maximum length of a media caption in characters */
  MAX_CAPTION_LENGTH: 1024,

  /** Minimum number of items allowed in a media group */
  MIN_MEDIA_GROUP_SIZE: 2,

  /** Maximum number of items allowed in a media group */
  MAX_MEDIA_GROUP_SIZE: 10,

  /** Maximum byte length of inline keyboard callback data */
  MAX_CALLBACK_DATA_BYTES: 64,

  /** Default channel rate limit: max messages per minute to prevent flood limits */
  CHANNEL_RATE_LIMIT_PER_MINUTE: 20,

  /** Global rate limit: max messages per second across all chats */
  GLOBAL_RATE_LIMIT_PER_SECOND: 30,

  /** Maximum supported file size for direct Telegram Bot API downloads/uploads in bytes (20MB / 50MB) */
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024, // 50 MB
} as const;
