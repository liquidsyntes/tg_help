import 'reflect-metadata';
import { AuditService } from '../../src/modules/audit/audit.service';
import { sanitizeAuditPayload } from '../../src/modules/audit/audit-payload.sanitizer';
import { ReviewsService } from '../../src/modules/reviews/reviews.service';
import { ReviewAction } from '@prisma/client';
import { ValidationException } from '../../src/common/exceptions/domain.exceptions';

describe('AuditService, Payload Sanitizer & ReviewsService Unit Tests', () => {
  describe('Payload Sanitizer (sanitizeAuditPayload)', () => {
    it('should redact Telegram bot token patterns in strings', () => {
      const payload = {
        message: 'Bot token is 123456789:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK11',
      };
      const sanitized = sanitizeAuditPayload(payload) as any;
      expect(sanitized.message).toBe('Bot token is [REDACTED_BOT_TOKEN]');
    });

    it('should redact database connection string credentials in strings', () => {
      const payload = {
        conn: 'postgresql://postgres:mySecretPass123@localhost:5432/tghelp',
      };
      const sanitized = sanitizeAuditPayload(payload) as any;
      expect(sanitized.conn).toBe('postgresql://postgres:[REDACTED]@localhost:5432/tghelp');
    });

    it('should redact sensitive keys (password, token, secret, api_key)', () => {
      const payload = {
        username: 'alice',
        password: 'superSecretPassword',
        bot_token: '12345:ABC',
        apiKey: 'key-12345',
      };
      const sanitized = sanitizeAuditPayload(payload) as any;
      expect(sanitized.username).toBe('alice');
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.bot_token).toBe('[REDACTED]');
      expect(sanitized.apiKey).toBe('[REDACTED]');
    });

    it('should convert BigInt to string and Date to ISO string', () => {
      const date = new Date('2026-09-21T12:00:00.000Z');
      const payload = {
        telegramId: 98765432101234n,
        createdAt: date,
      };
      const sanitized = sanitizeAuditPayload(payload) as any;
      expect(sanitized.telegramId).toBe('98765432101234');
      expect(sanitized.createdAt).toBe('2026-09-21T12:00:00.000Z');
    });
  });

  describe('AuditService Append-Only Operations', () => {
    let auditService: AuditService;
    let mockPrisma: any;
    let mockLogger: any;

    beforeEach(() => {
      mockPrisma = {
        auditLog: {
          create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'aud-1', ...data })),
          findMany: jest.fn(),
        },
      };
      mockLogger = {
        debug: jest.fn(),
        log: jest.fn(),
      };
      auditService = new AuditService(mockPrisma as any, mockLogger as any);
    });

    it('should record an audit log with sanitized payload', async () => {
      const entry = await auditService.record({
        action: 'settings_changed',
        entityType: 'user',
        entityId: 'u1',
        actorId: 'admin-1',
        payload: {
          secret_key: 'top-secret',
          public_info: 'allowed',
        },
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'settings_changed',
          entityType: 'user',
          entityId: 'u1',
          actorId: 'admin-1',
          payload: {
            secret_key: '[REDACTED]',
            public_info: 'allowed',
          },
        }),
      });
      expect(entry.id).toBe('aud-1');
    });

    it('should use transaction client if provided', async () => {
      const mockTx = {
        auditLog: {
          create: jest.fn().mockResolvedValue({ id: 'tx-aud-1' }),
        },
      };

      const entry = await auditService.record(
        {
          action: 'post_created',
          entityType: 'post',
          entityId: 'p1',
        },
        mockTx as any,
      );

      expect(mockTx.auditLog.create).toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
      expect(entry.id).toBe('tx-aud-1');
    });

    it('should retrieve audit logs by entity in chronological order', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([
        { id: '1', action: 'post_created' },
        { id: '2', action: 'submitted_for_review' },
      ]);

      const logs = await auditService.findByEntity('post', 'p1');
      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
        where: { entityType: 'post', entityId: 'p1' },
        orderBy: { createdAt: 'asc' },
      });
      expect(logs).toHaveLength(2);
    });
  });

  describe('ReviewsService', () => {
    let reviewsService: ReviewsService;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        postReview: {
          create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'rev-1', ...data })),
          findMany: jest.fn(),
          findFirst: jest.fn(),
        },
      };
      reviewsService = new ReviewsService(mockPrisma as any);
    });

    it('should reject REQUEST_REVISION with empty comment', async () => {
      await expect(
        reviewsService.createReview({
          postId: 'p1',
          reviewerId: 'ed-1',
          action: ReviewAction.REQUEST_REVISION,
          comment: '',
        }),
      ).rejects.toThrow(ValidationException);
      await expect(
        reviewsService.createReview({
          postId: 'p1',
          reviewerId: 'ed-1',
          action: ReviewAction.REQUEST_REVISION,
          comment: '   ',
        }),
      ).rejects.toThrow(/Для возврата на доработку обязателен комментарий/);
    });

    it('should create review for REQUEST_REVISION when comment is provided', async () => {
      const review = await reviewsService.createReview({
        postId: 'p1',
        reviewerId: 'ed-1',
        action: ReviewAction.REQUEST_REVISION,
        comment: 'Please fix typos in section 2',
      });

      expect(mockPrisma.postReview.create).toHaveBeenCalledWith({
        data: {
          postId: 'p1',
          reviewerId: 'ed-1',
          action: ReviewAction.REQUEST_REVISION,
          comment: 'Please fix typos in section 2',
        },
      });
      expect(review.id).toBe('rev-1');
    });

    it('should allow APPROVE without a comment', async () => {
      const review = await reviewsService.createReview({
        postId: 'p1',
        reviewerId: 'ed-1',
        action: ReviewAction.APPROVE,
      });

      expect(mockPrisma.postReview.create).toHaveBeenCalledWith({
        data: {
          postId: 'p1',
          reviewerId: 'ed-1',
          action: ReviewAction.APPROVE,
          comment: null,
        },
      });
      expect(review.id).toBe('rev-1');
    });

    it('should fetch latest review ordered by createdAt desc', async () => {
      mockPrisma.postReview.findFirst.mockResolvedValue({
        id: 'rev-latest',
        comment: 'Latest comment',
      });

      const latest = await reviewsService.getLatestReview('p1');
      expect(mockPrisma.postReview.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { postId: 'p1' },
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(latest?.id).toBe('rev-latest');
    });
  });
});
