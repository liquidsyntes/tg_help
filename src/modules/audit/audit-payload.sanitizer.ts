/**
 * Recursive Payload Sanitizer for Audit Logging
 * Authoritative reference: AGENTS.md § 33, § 34; tasks.md § 26
 */

const SENSITIVE_KEY_SUBSTRINGS = [
  'token',
  'bottoken',
  'bot_token',
  'password',
  'secret',
  'webhook_secret',
  'database_url',
  'redis_url',
  'authorization',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'cookie',
  'credential',
];

// Telegram Bot Token pattern: e.g. 123456789:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK11
const BOT_TOKEN_REGEX = /\b\d{8,11}:[A-Za-z0-9_-]{35,}\b/g;

// Connection string password redaction (e.g. postgresql://user:pass@host:5432/db)
const URI_CREDENTIAL_REGEX = /(postgres(?:ql)?|redis):\/\/([^:]+):([^@]+)@/gi;

/**
 * Recursively sanitizes data before storing in audit logs.
 * Redacts secrets, tokens, credentials, and converts non-serializable objects (BigInt, Error, Date).
 */
export function sanitizeAuditPayload<T = unknown>(obj: T, depth = 0): unknown {
  if (depth > 6 || obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  if (typeof obj === 'string') {
    let clean = obj.replace(BOT_TOKEN_REGEX, '[REDACTED_BOT_TOKEN]');
    clean = clean.replace(URI_CREDENTIAL_REGEX, '$1://$2:[REDACTED]@');
    return clean;
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeAuditPayload(item, depth + 1));
  }

  if (typeof obj === 'object') {
    if (obj instanceof Date) {
      return obj.toISOString();
    }
    if (obj instanceof Error) {
      return {
        name: obj.name,
        message: obj.message.replace(BOT_TOKEN_REGEX, '[REDACTED_BOT_TOKEN]'),
      };
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      const isSensitiveKey = SENSITIVE_KEY_SUBSTRINGS.some((substring) => lowerKey.includes(substring));

      if (isSensitiveKey) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeAuditPayload(value, depth + 1);
      }
    }
    return sanitized;
  }

  return String(obj);
}
