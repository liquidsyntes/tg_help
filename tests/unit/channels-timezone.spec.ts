import 'reflect-metadata';
import { ChannelsService } from '../../src/modules/channels/channels.service';
import {
  parseAndValidateScheduledDate,
  formatChannelDate,
} from '../../src/modules/channels/utils/timezone.util';
import { ValidationException } from '../../src/common/exceptions/domain.exceptions';
import { SystemRole } from '@prisma/client';

describe('ChannelsService & Timezone Utilities Unit Tests', () => {
  describe('Timezone Conversion & Validation (parseAndValidateScheduledDate)', () => {
    const fixedNowMs = new Date('2026-09-21T10:00:00Z').getTime();

    it('should parse dd.MM.yyyy HH:mm in Europe/Kyiv and convert to UTC Date', () => {
      // In September, Kyiv is UTC+3 (EEST)
      const input = '21.09.2026 18:30';
      const parsed = parseAndValidateScheduledDate(input, 'Europe/Kyiv', fixedNowMs);

      expect(parsed).toBeInstanceOf(Date);
      // 18:30 Kyiv (UTC+3) = 15:30 UTC
      expect(parsed.toISOString()).toBe('2026-09-21T15:30:00.000Z');
    });

    it('should parse yyyy-MM-dd HH:mm format', () => {
      const input = '2026-09-22 12:00';
      const parsed = parseAndValidateScheduledDate(input, 'Europe/Kyiv', fixedNowMs);

      expect(parsed.toISOString()).toBe('2026-09-22T09:00:00.000Z');
    });

    it('should parse ISO 8601 string format', () => {
      const input = '2026-09-23T14:00:00.000Z';
      const parsed = parseAndValidateScheduledDate(input, 'Europe/Kyiv', fixedNowMs);

      expect(parsed.toISOString()).toBe('2026-09-23T14:00:00.000Z');
    });

    it('should reject past dates with Russian validation message', () => {
      const pastInput = '20.09.2026 12:00'; // 1 day before fixedNowMs
      expect(() => parseAndValidateScheduledDate(pastInput, 'Europe/Kyiv', fixedNowMs)).toThrow(
        ValidationException,
      );
      expect(() => parseAndValidateScheduledDate(pastInput, 'Europe/Kyiv', fixedNowMs)).toThrow(
        /Нельзя планировать публикацию в прошлом/,
      );
    });

    it('should reject invalid date string format', () => {
      expect(() => parseAndValidateScheduledDate('invalid-date', 'Europe/Kyiv', fixedNowMs)).toThrow(
        ValidationException,
      );
      expect(() => parseAndValidateScheduledDate('32.13.2026 99:99', 'Europe/Kyiv', fixedNowMs)).toThrow(
        /Некорректный формат даты/,
      );
    });

    it('should format UTC Date back to channel timezone string (dd.MM.yyyy HH:mm)', () => {
      const utcDate = new Date('2026-09-21T15:30:00.000Z');
      const formatted = formatChannelDate(utcDate, 'Europe/Kyiv');
      expect(formatted).toBe('21.09.2026 18:30');
    });
  });

  describe('ChannelsService.autoSkipSingleChannel', () => {
    let channelsService: ChannelsService;
    let mockPrisma: any;
    let mockAudit: any;

    const channelA = {
      id: 'chan-1',
      title: 'Channel One',
      telegramChatId: '-1001',
      timezone: 'Europe/Kyiv',
      isActive: true,
    };
    const channelB = {
      id: 'chan-2',
      title: 'Channel Two',
      telegramChatId: '-1002',
      timezone: 'Europe/Kyiv',
      isActive: true,
    };

    beforeEach(() => {
      mockPrisma = {
        user: { findUnique: jest.fn() },
        channel: { findMany: jest.fn() },
        channelMember: { findMany: jest.fn() },
      };
      mockAudit = { record: jest.fn() };
      channelsService = new ChannelsService(mockPrisma as any, mockAudit as any);
    });

    it('should return mustChoose: false and singleChannel when user has access to exactly 1 channel', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: true, systemRole: SystemRole.USER });
      mockPrisma.channelMember.findMany.mockResolvedValue([{ channel: channelA }]);

      const result = await channelsService.autoSkipSingleChannel('u1');
      expect(result.mustChoose).toBe(false);
      expect(result.singleChannel?.id).toBe('chan-1');
      expect(result.channels).toHaveLength(1);
    });

    it('should return mustChoose: true and singleChannel: null when user has access to multiple channels', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: true, systemRole: SystemRole.USER });
      mockPrisma.channelMember.findMany.mockResolvedValue([{ channel: channelA }, { channel: channelB }]);

      const result = await channelsService.autoSkipSingleChannel('u1');
      expect(result.mustChoose).toBe(true);
      expect(result.singleChannel).toBeNull();
      expect(result.channels).toHaveLength(2);
    });

    it('should return mustChoose: false and singleChannel: null when user has 0 channels', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: true, systemRole: SystemRole.USER });
      mockPrisma.channelMember.findMany.mockResolvedValue([]);

      const result = await channelsService.autoSkipSingleChannel('u1');
      expect(result.mustChoose).toBe(false);
      expect(result.singleChannel).toBeNull();
      expect(result.channels).toHaveLength(0);
    });
  });
});
