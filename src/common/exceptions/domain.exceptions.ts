/**
 * Standard Domain Exceptions
 * Authoritative reference: AGENTS.md § 32, PROJECT.md Interface Contracts
 */

export abstract class DomainException extends Error {
  abstract readonly statusCode: number;
  abstract readonly errorCode: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class UnauthorizedUserException extends DomainException {
  readonly statusCode = 401;
  readonly errorCode = 'UNAUTHORIZED_USER';
  readonly userFriendlyMessage = 'У вас пока нет доступа к редакции. Обратитесь к администратору.';

  constructor(telegramId?: bigint | string) {
    super(`Access denied. У вас пока нет доступа к редакции. Обратитесь к администратору. Telegram ID: ${telegramId ?? 'unknown'}`);
  }
}

export class UserDeactivatedException extends DomainException {
  readonly statusCode = 403;
  readonly errorCode = 'USER_DEACTIVATED';
  readonly userFriendlyMessage = 'Ваш аккаунт деактивирован. Обратитесь к администратору.';

  constructor(telegramId?: bigint | string) {
    super(`Access denied. Ваш аккаунт деактивирован. Обратитесь к администратору. Telegram ID: ${telegramId ?? 'unknown'}`);
  }
}

export class PermissionDeniedException extends DomainException {
  readonly statusCode = 403;
  readonly errorCode = 'PERMISSION_DENIED';

  constructor(action: string, channelId?: string, message?: string) {
    super(message || `Permission denied for action "${action}"${channelId ? ` in channel "${channelId}"` : ''}.`);
  }
}

export class PostNotFoundException extends DomainException {
  readonly statusCode = 404;
  readonly errorCode = 'POST_NOT_FOUND';

  constructor(postId: string) {
    super(`Post with ID "${postId}" not found.`);
  }
}

export class ChannelNotFoundException extends DomainException {
  readonly statusCode = 404;
  readonly errorCode = 'CHANNEL_NOT_FOUND';

  constructor(channelId: string) {
    super(`Channel with ID "${channelId}" not found.`);
  }
}

export class InvalidPostStateTransitionException extends DomainException {
  readonly statusCode = 400;
  readonly errorCode = 'INVALID_STATE_TRANSITION';

  constructor(currentStatus: string, attemptedActionOrTarget: string) {
    super(`Cannot transition post from status "${currentStatus}" to/via "${attemptedActionOrTarget}".`);
  }
}

export const InvalidStateTransitionException = InvalidPostStateTransitionException;
export type InvalidStateTransitionException = InvalidPostStateTransitionException;

export class PostConflictException extends DomainException {
  readonly statusCode = 409;
  readonly errorCode = 'POST_CONFLICT';

  constructor(postIdOrMessage: string, expectedVersion?: number, actualVersion?: number) {
    let message: string;
    if (expectedVersion !== undefined) {
      message = `Публикация была изменена другим пользователем. Optimistic concurrency conflict on post "${postIdOrMessage}". Expected version ${expectedVersion}, but found ${actualVersion ?? 'different'}.`;
    } else if (postIdOrMessage.includes('Публикация была изменена другим пользователем')) {
      message = postIdOrMessage;
    } else {
      message = `Публикация была изменена другим пользователем. ${postIdOrMessage}`;
    }
    super(message);
  }
}

export class IdempotencyConflictException extends DomainException {
  readonly statusCode = 409;
  readonly errorCode = 'IDEMPOTENCY_CONFLICT';

  constructor(idempotencyKey: string) {
    super(`Publication already processed or enqueued for idempotency key "${idempotencyKey}".`);
  }
}

export class InvalidTemplateException extends DomainException {
  readonly statusCode = 400;
  readonly errorCode = 'INVALID_TEMPLATE';

  constructor(message: string) {
    super(message);
  }
}

export class TemplateNotFoundException extends DomainException {
  readonly statusCode = 404;
  readonly errorCode = 'TEMPLATE_NOT_FOUND';

  constructor(idOrKey: string) {
    super(`Template with ID or key "${idOrKey}" not found.`);
  }
}

export class MediaNotFoundException extends DomainException {
  readonly statusCode = 404;
  readonly errorCode = 'MEDIA_NOT_FOUND';

  constructor(mediaId: string) {
    super(`Media item with ID "${mediaId}" not found.`);
  }
}

export class ValidationException extends DomainException {
  readonly statusCode = 400;
  readonly errorCode = 'VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
  }
}

export const ValidationError = ValidationException;
export type ValidationError = ValidationException;
