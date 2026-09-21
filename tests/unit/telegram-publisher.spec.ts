import 'reflect-metadata';
import { GrammyError, HttpError } from 'grammy';
import {
  TelegramPublisherService,
  TelegramErrorClassifier,
  TelegramErrorCategory,
  TelegramRateLimitException,
  TelegramRetryableException,
  TelegramPermanentException,
} from '../../src/infrastructure/telegram-api';
import { TELEGRAM_LIMITS } from '../../src/common/constants/telegram-limits';

describe('Telegram API Abstraction & Error Classifier Unit Tests', () => {
  describe('TelegramErrorClassifier', () => {
    it('should classify 429 with parameters.retry_after as RATE_LIMITED', () => {
      const error = new GrammyError('Too Many Requests: retry after 12', {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 12',
        parameters: { retry_after: 12 },
      } as any, 'sendMessage', {});

      const result = TelegramErrorClassifier.classify(error);
      expect(result.category).toBe(TelegramErrorCategory.RATE_LIMITED);
      expect(result.statusCode).toBe(429);
      expect(result.retryAfterSeconds).toBe(12);
      expect(result.isRetryable).toBe(true);
      expect(result.isPermanent).toBe(false);
    });

    it('should extract retry_after from description regex when parameters missing', () => {
      const error = new GrammyError('Too Many Requests: retry after 30', {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 30',
      } as any, 'sendMessage', {});

      const result = TelegramErrorClassifier.classify(error);
      expect(result.category).toBe(TelegramErrorCategory.RATE_LIMITED);
      expect(result.retryAfterSeconds).toBe(30);
    });

    it('should classify 5xx server errors as RETRYABLE', () => {
      const codes = [500, 502, 503, 504];
      for (const code of codes) {
        const error = new GrammyError(`Server error ${code}`, {
          ok: false,
          error_code: code,
          description: `Internal Telegram error ${code}`,
        } as any, 'sendMessage', {});

        const result = TelegramErrorClassifier.classify(error);
        expect(result.category).toBe(TelegramErrorCategory.RETRYABLE);
        expect(result.statusCode).toBe(code);
        expect(result.isRetryable).toBe(true);
        expect(result.isPermanent).toBe(false);
      }
    });

    it('should classify network socket and timeout errors as RETRYABLE', () => {
      const networkErrors = [
        new Error('read ECONNRESET'),
        new Error('connect ETIMEDOUT 149.154.167.220:443'),
        new Error('getaddrinfo ENOTFOUND api.telegram.org'),
        new Error('connect ECONNREFUSED 127.0.0.1:8081'),
        new Error('fetch failed'),
        new Error('socket hang up'),
      ];

      for (const err of networkErrors) {
        const result = TelegramErrorClassifier.classify(err);
        expect(result.category).toBe(TelegramErrorCategory.RETRYABLE);
        expect(result.isRetryable).toBe(true);
        expect(result.isPermanent).toBe(false);
      }
    });

    it('should classify HttpError as RETRYABLE', () => {
      const httpError = new HttpError('Network Failure', new Error('Connection reset'));
      const result = TelegramErrorClassifier.classify(httpError);
      expect(result.category).toBe(TelegramErrorCategory.RETRYABLE);
      expect(result.isRetryable).toBe(true);
    });

    it('should classify 400 Bad Request as PERMANENT', () => {
      const error = new GrammyError('Bad Request: chat not found', {
        ok: false,
        error_code: 400,
        description: 'Bad Request: chat not found',
      } as any, 'sendMessage', {});

      const result = TelegramErrorClassifier.classify(error);
      expect(result.category).toBe(TelegramErrorCategory.PERMANENT);
      expect(result.statusCode).toBe(400);
      expect(result.isRetryable).toBe(false);
      expect(result.isPermanent).toBe(true);
    });

    it('should classify 403 Forbidden (bot kicked/not admin) as PERMANENT', () => {
      const error = new GrammyError('Forbidden: bot was kicked from the channel', {
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot was kicked from the channel',
      } as any, 'sendMessage', {});

      const result = TelegramErrorClassifier.classify(error);
      expect(result.category).toBe(TelegramErrorCategory.PERMANENT);
      expect(result.statusCode).toBe(403);
      expect(result.isPermanent).toBe(true);
    });

    it('should handle custom domain exceptions directly', () => {
      const rateLimitEx = new TelegramRateLimitException('Rate limit exceeded', 7);
      expect(TelegramErrorClassifier.classify(rateLimitEx)).toEqual({
        category: TelegramErrorCategory.RATE_LIMITED,
        statusCode: 429,
        retryAfterSeconds: 7,
        isPermanent: false,
        isRetryable: true,
        sanitizedMessage: 'Rate limit exceeded',
      });

      const retryableEx = new TelegramRetryableException('Gateway timeout', 504);
      expect(TelegramErrorClassifier.classify(retryableEx)).toEqual({
        category: TelegramErrorCategory.RETRYABLE,
        statusCode: 504,
        retryAfterSeconds: null,
        isPermanent: false,
        isRetryable: true,
        sanitizedMessage: 'Gateway timeout',
      });

      const permEx = new TelegramPermanentException('Invalid entities', 400);
      expect(TelegramErrorClassifier.classify(permEx)).toEqual({
        category: TelegramErrorCategory.PERMANENT,
        statusCode: 400,
        retryAfterSeconds: null,
        isPermanent: true,
        isRetryable: false,
        sanitizedMessage: 'Invalid entities',
      });
    });
  });

  describe('TelegramPublisherService', () => {
    let service: TelegramPublisherService;
    let mockApi: any;

    beforeEach(() => {
      service = new TelegramPublisherService();
      mockApi = {
        sendMessage: jest.fn().mockResolvedValue({ message_id: 1001 }),
        sendPhoto: jest.fn().mockResolvedValue({ message_id: 1002 }),
        sendVideo: jest.fn().mockResolvedValue({ message_id: 1003 }),
        sendDocument: jest.fn().mockResolvedValue({ message_id: 1004 }),
        sendAnimation: jest.fn().mockResolvedValue({ message_id: 1005 }),
        sendMediaGroup: jest.fn().mockResolvedValue([{ message_id: 1006 }, { message_id: 1007 }]),
      };
      service.setApi(mockApi);
    });

    it('should accept string and bigint chat IDs', async () => {
      const id1 = await service.sendMessage('-1001234567890', 'Test message');
      expect(id1).toBe(1001);
      expect(mockApi.sendMessage).toHaveBeenCalledWith('-1001234567890', 'Test message', expect.any(Object));

      const id2 = await service.sendMessage(987654321n, 'Test message');
      expect(id2).toBe(1001);
      expect(mockApi.sendMessage).toHaveBeenCalledWith('987654321', 'Test message', expect.any(Object));
    });

    it('should reject empty chatId with TelegramPermanentException', async () => {
      await expect(service.sendMessage('', 'Text')).rejects.toThrow(TelegramPermanentException);
      await expect(service.sendMessage('   ', 'Text')).rejects.toThrow(/Chat ID cannot be empty/);
    });

    it('should reject empty message text and text exceeding 4096 chars', async () => {
      await expect(service.sendMessage('-1001', '')).rejects.toThrow(TelegramPermanentException);
      await expect(service.sendMessage('-1001', '   ')).rejects.toThrow(/Message text cannot be empty/);

      const longText = 'a'.repeat(TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH + 1);
      await expect(service.sendMessage('-1001', longText)).rejects.toThrow(
        /Message text exceeds Telegram limit of 4096 characters/,
      );
    });

    it('should reject captions exceeding 1024 characters for media methods', async () => {
      const longCaption = 'c'.repeat(TELEGRAM_LIMITS.MAX_CAPTION_LENGTH + 1);

      await expect(service.sendPhoto('-1001', 'file-id', { caption: longCaption })).rejects.toThrow(
        /Media caption exceeds Telegram limit of 1024 characters/,
      );
      await expect(service.sendVideo('-1001', 'file-id', { caption: longCaption })).rejects.toThrow(
        /Media caption exceeds Telegram limit of 1024 characters/,
      );
      await expect(service.sendDocument('-1001', 'file-id', { caption: longCaption })).rejects.toThrow(
        /Media caption exceeds Telegram limit of 1024 characters/,
      );
      await expect(service.sendAnimation('-1001', 'file-id', { caption: longCaption })).rejects.toThrow(
        /Media caption exceeds Telegram limit of 1024 characters/,
      );
    });

    it('should enforce media group limits (2 to 10 items)', async () => {
      await expect(
        service.sendMediaGroup('-1001', [{ type: 'photo', fileId: 'p1' }]),
      ).rejects.toThrow(/Media group must contain between 2 and 10 items/);

      const elevenItems = Array(11).fill(null).map((_, idx) => ({
        type: 'photo' as const,
        fileId: `p-${idx}`,
      }));
      await expect(service.sendMediaGroup('-1001', elevenItems)).rejects.toThrow(
        /Media group must contain between 2 and 10 items/,
      );

      const validItems = [
        { type: 'photo' as const, fileId: 'p1' },
        { type: 'photo' as const, fileId: 'p2' },
      ];
      const result = await service.sendMediaGroup('-1001', validItems);
      expect(result).toEqual([1006, 1007]);
    });

    it('should publish all outgoing message types in publishOutgoingMessage', async () => {
      // Text
      const textIds = await service.publishOutgoingMessage('-1001', {
        partIndex: 0,
        type: 'text',
        html: '<b>Hello</b>',
      });
      expect(textIds).toEqual([1001]);

      // Photo
      const photoIds = await service.publishOutgoingMessage('-1001', {
        partIndex: 1,
        type: 'photo',
        fileId: 'photo-1',
        caption: 'Cap',
      });
      expect(photoIds).toEqual([1002]);

      // Video
      const videoIds = await service.publishOutgoingMessage('-1001', {
        partIndex: 2,
        type: 'video',
        fileId: 'video-1',
      });
      expect(videoIds).toEqual([1003]);

      // Document
      const docIds = await service.publishOutgoingMessage('-1001', {
        partIndex: 3,
        type: 'document',
        fileId: 'doc-1',
      });
      expect(docIds).toEqual([1004]);

      // Animation
      const animIds = await service.publishOutgoingMessage('-1001', {
        partIndex: 4,
        type: 'animation',
        fileId: 'anim-1',
      });
      expect(animIds).toEqual([1005]);

      // Media Group
      const mgIds = await service.publishOutgoingMessage('-1001', {
        partIndex: 5,
        type: 'media_group',
        items: [
          { type: 'photo', fileId: 'mg-p1' },
          { type: 'video', fileId: 'mg-v1' },
        ],
      });
      expect(mgIds).toEqual([1006, 1007]);
    });

    it('should wrap Telegram errors in typed exceptions', async () => {
      mockApi.sendMessage.mockRejectedValueOnce(
        new GrammyError('Too Many Requests: retry after 8', {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 8',
          parameters: { retry_after: 8 },
        } as any, 'sendMessage', {}),
      );

      await expect(service.sendMessage('-1001', 'Test')).rejects.toThrow(TelegramRateLimitException);

      mockApi.sendMessage.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
      await expect(service.sendMessage('-1001', 'Test')).rejects.toThrow(TelegramRetryableException);

      mockApi.sendMessage.mockRejectedValueOnce(
        new GrammyError('Bad Request: chat not found', {
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found',
        } as any, 'sendMessage', {}),
      );
      await expect(service.sendMessage('-1001', 'Test')).rejects.toThrow(TelegramPermanentException);
    });
  });
});
