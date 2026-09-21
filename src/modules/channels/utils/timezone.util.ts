import { DateTime, IANAZone } from 'luxon';
import { ValidationException } from '../../../common/exceptions/domain.exceptions';

export const DEFAULT_CHANNEL_TIMEZONE = 'Europe/Kyiv';

/**
 * Parses and validates a publication schedule date string in the context of the channel's timezone.
 * Returns a native JavaScript Date object representing the UTC instant.
 * Throws ValidationException if invalid format or if date is in the past.
 */
export function parseAndValidateScheduledDate(
  input: string,
  channelTimezone = DEFAULT_CHANNEL_TIMEZONE,
  nowMs = Date.now(),
): Date {
  const trimmed = input.trim();
  const zone = IANAZone.isValidZone(channelTimezone) ? channelTimezone : DEFAULT_CHANNEL_TIMEZONE;

  let dt = DateTime.fromFormat(trimmed, 'dd.MM.yyyy HH:mm', { zone });
  if (!dt.isValid) {
    dt = DateTime.fromFormat(trimmed, 'yyyy-MM-dd HH:mm', { zone });
  }
  if (!dt.isValid) {
    dt = DateTime.fromISO(trimmed, { zone });
  }

  if (!dt.isValid) {
    throw new ValidationException(
      `Некорректный формат даты: "${input}". Используйте формат ДД.ММ.ГГГГ ЧЧ:ММ (например: 21.09.2026 18:30)`,
    );
  }

  const date = dt.toJSDate();
  if (date.getTime() <= nowMs) {
    throw new ValidationException('Нельзя планировать публикацию в прошлом.');
  }

  return date;
}

/**
 * Formats a UTC Date into the channel's local timezone string (dd.MM.yyyy HH:mm).
 */
export function formatChannelDate(
  date: Date,
  channelTimezone = DEFAULT_CHANNEL_TIMEZONE,
): string {
  const zone = IANAZone.isValidZone(channelTimezone) ? channelTimezone : DEFAULT_CHANNEL_TIMEZONE;
  return DateTime.fromJSDate(date).setZone(zone).toFormat('dd.MM.yyyy HH:mm');
}
