import 'reflect-metadata';
import { MediaService } from '../../src/modules/media/media.service';
import {
  isDocumentAsVideo,
  validateMediaGroupCompatibility,
} from '../../src/modules/media/utils/media-detector.util';
import { MediaType, PostStatus, PostTemplate } from '@prisma/client';
import { AuditAction } from '../../src/common/enums';
import {
  PostNotFoundException,
  MediaNotFoundException,
  ValidationException,
} from '../../src/common/exceptions/domain.exceptions';

describe('Media Module Unit Tests', () => {
  let mediaService: MediaService;
  let mockPrisma: any;
  let mockPostsRepo: any;
  let mockAuditService: any;
  let mockPermissionService: any;

  const basePost = {
    id: 'post-1',
    channelId: 'chan-1',
    authorId: 'author-1',
    templateId: 'tpl-1',
    status: PostStatus.DRAFT,
    version: 1,
    deletedAt: null,
  };

  beforeEach(() => {
    mockPrisma = {
      $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      postMedia: {
        count: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
        update: jest.fn(),
      },
    };

    mockPostsRepo = {
      findById: jest.fn().mockResolvedValue(basePost),
      updateWithOcc: jest.fn().mockResolvedValue({ ...basePost, version: 2 }),
    };

    mockAuditService = {
      record: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    };

    mockPermissionService = {
      enforcePostEditPermission: jest.fn().mockResolvedValue(undefined),
    };

    mediaService = new MediaService(
      mockPrisma as any,
      mockPostsRepo as any,
      mockAuditService as any,
      mockPermissionService as any,
    );
  });

  describe('MediaService.attachMedia (Zero-Download file_id reuse)', () => {
    it('should persist Telegram file_id directly without downloading bytes and bump post version via OCC', async () => {
      mockPrisma.postMedia.count.mockResolvedValue(0);
      mockPrisma.postMedia.findFirst.mockResolvedValue(null);
      mockPrisma.postMedia.create.mockResolvedValue({ id: 'm1' });

      const result = await mediaService.attachMedia('post-1', 1, 'author-1', {
        telegramFileId: 'BQACAgIAAxkBAAI...',
        telegramFileUniqueId: 'unique_123',
        mediaType: MediaType.PHOTO,
        caption: 'Sample photo',
      });

      expect(result.version).toBe(2);
      expect(mockPrisma.postMedia.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          postId: 'post-1',
          telegramFileId: 'BQACAgIAAxkBAAI...',
          telegramFileUniqueId: 'unique_123',
          mediaType: MediaType.PHOTO,
          sortOrder: 1,
        }),
      });
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.MEDIA_ADDED,
          entityType: 'post',
          entityId: 'post-1',
        }),
        expect.anything(),
      );
    });

    it('should reject attachment if post has already reached the maximum limit of 10 items', async () => {
      mockPrisma.postMedia.count.mockResolvedValue(10);

      await expect(
        mediaService.attachMedia('post-1', 1, 'author-1', {
          telegramFileId: 'f1',
          telegramFileUniqueId: 'u1',
          mediaType: MediaType.PHOTO,
        }),
      ).rejects.toThrow(ValidationException);
    });

    it('should reject attachment if post is not in editable status (e.g. PUBLISHED or PENDING_REVIEW)', async () => {
      mockPostsRepo.findById.mockResolvedValue({
        ...basePost,
        status: PostStatus.PENDING_REVIEW,
      });

      await expect(
        mediaService.attachMedia('post-1', 1, 'author-1', {
          telegramFileId: 'f1',
          telegramFileUniqueId: 'u1',
          mediaType: MediaType.PHOTO,
        }),
      ).rejects.toThrow(ValidationException);
    });
  });

  describe('MediaService.attachMediaBatch', () => {
    it('should attach multiple media items in single transaction with sequential sort orders', async () => {
      mockPrisma.postMedia.count.mockResolvedValue(1);
      mockPrisma.postMedia.findFirst.mockResolvedValue({ sortOrder: 1 });

      const items = [
        { telegramFileId: 'f2', telegramFileUniqueId: 'u2', mediaType: MediaType.PHOTO },
        { telegramFileId: 'f3', telegramFileUniqueId: 'u3', mediaType: MediaType.PHOTO },
      ];

      const result = await mediaService.attachMediaBatch('post-1', 1, 'author-1', items);

      expect(result.version).toBe(2);
      expect(mockPrisma.postMedia.create).toHaveBeenCalledTimes(2);
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.MEDIA_ADDED,
          payload: expect.objectContaining({ count: 2 }),
        }),
        expect.anything(),
      );
    });

    it('should reject batch if combined count exceeds 10', async () => {
      mockPrisma.postMedia.count.mockResolvedValue(9);

      const items = [
        { telegramFileId: 'f2', telegramFileUniqueId: 'u2', mediaType: MediaType.PHOTO },
        { telegramFileId: 'f3', telegramFileUniqueId: 'u3', mediaType: MediaType.PHOTO },
      ];

      await expect(
        mediaService.attachMediaBatch('post-1', 1, 'author-1', items),
      ).rejects.toThrow(ValidationException);
    });
  });

  describe('MediaService.removeMedia', () => {
    it('should delete media and renormalize remaining items sortOrder (gapless 1..N)', async () => {
      mockPrisma.postMedia.findUnique.mockResolvedValue({
        id: 'med-2',
        postId: 'post-1',
        telegramFileUniqueId: 'u2',
        sortOrder: 2,
      });

      // Remaining items after deleting med-2 (was sortOrder 1 and 3)
      mockPrisma.postMedia.findMany.mockResolvedValue([
        { id: 'med-1', sortOrder: 1 },
        { id: 'med-3', sortOrder: 3 },
      ]);

      const result = await mediaService.removeMedia('post-1', 'med-2', 1, 'author-1');

      expect(result.version).toBe(2);
      expect(mockPrisma.postMedia.delete).toHaveBeenCalledWith({ where: { id: 'med-2' } });
      // med-3 should be updated to sortOrder 2
      expect(mockPrisma.postMedia.update).toHaveBeenCalledWith({
        where: { id: 'med-3' },
        data: { sortOrder: 2 },
      });
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.MEDIA_REMOVED,
          entityId: 'post-1',
        }),
        expect.anything(),
      );
    });

    it('should throw MediaNotFoundException if media does not exist or belongs to another post', async () => {
      mockPrisma.postMedia.findUnique.mockResolvedValue({
        id: 'med-alien',
        postId: 'other-post',
      });

      await expect(
        mediaService.removeMedia('post-1', 'med-alien', 1, 'author-1'),
      ).rejects.toThrow(MediaNotFoundException);
    });
  });

  describe('Media Group Limits & Compatibility (validateMediaGroupCompatibility)', () => {
    it('should allow 2-10 photos and videos in album', () => {
      const album = [
        { mediaType: MediaType.PHOTO },
        { mediaType: MediaType.VIDEO },
        { mediaType: MediaType.PHOTO },
      ];
      const result = validateMediaGroupCompatibility(album);
      expect(result.isValid).toBe(true);
      expect(result.isAlbum).toBe(true);
    });

    it('should allow document albums with only documents', () => {
      const docAlbum = [{ mediaType: MediaType.DOCUMENT }, { mediaType: MediaType.DOCUMENT }];
      const result = validateMediaGroupCompatibility(docAlbum);
      expect(result.isValid).toBe(true);
      expect(result.isAlbum).toBe(true);
    });

    it('should reject mixing photos/videos and documents in the same group', () => {
      const mixed = [{ mediaType: MediaType.PHOTO }, { mediaType: MediaType.DOCUMENT }];
      const result = validateMediaGroupCompatibility(mixed);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Нельзя объединять фото/видео и документы');
    });

    it('should reject GIF animations from media groups', () => {
      const withGif = [{ mediaType: MediaType.PHOTO }, { mediaType: MediaType.ANIMATION }];
      const result = validateMediaGroupCompatibility(withGif);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('GIF-анимации нельзя объединять в медиагруппу');
    });

    it('should reject albums with more than 10 items', () => {
      const largeGroup = Array(11).fill({ mediaType: MediaType.PHOTO });
      const result = validateMediaGroupCompatibility(largeGroup);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('не может содержать более 10 элементов');
    });
  });

  describe('Document-as-Video Handling', () => {
    it('should detect uncompressed video documents by MIME type', () => {
      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'video/mp4',
          fileName: 'clip.dat',
        }),
      ).toBe(true);

      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'video/quicktime',
        }),
      ).toBe(true);
    });

    it('should detect uncompressed video documents by file extension', () => {
      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'application/octet-stream',
          fileName: 'movie.mov',
        }),
      ).toBe(true);

      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          fileName: 'clip.mp4',
        }),
      ).toBe(true);
    });

    it('should not flag standard PDFs or spreadsheets as video documents', () => {
      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'application/pdf',
          fileName: 'document.pdf',
        }),
      ).toBe(false);
    });

    it('should enrich media item with isVideoDocument and transportMethod sendDocument', async () => {
      mockPrisma.postMedia.findMany.mockResolvedValue([
        {
          id: 'm1',
          postId: 'post-1',
          telegramFileId: 'f1',
          telegramFileUniqueId: 'u1',
          mediaType: MediaType.DOCUMENT,
          fileName: '4k_footage.mp4',
          mimeType: 'video/mp4',
          fileSize: BigInt(50000000),
          sortOrder: 1,
        },
      ]);

      const enriched = await mediaService.getMediaForPost('post-1');
      expect(enriched).toHaveLength(1);
      expect(enriched[0]?.isVideoDocument).toBe(true);
      // Notice: transport method is sendDocument (avoiding 400 Bad Request: wrong remote file identifier)
      expect(enriched[0]?.transportMethod).toBe('sendDocument');
    });

    it('should accept document-as-video for video template during validation', async () => {
      const videoTemplate = {
        key: 'video',
        name: 'Видео',
        supportedMediaTypes: ['video'],
      } as PostTemplate;

      mockPrisma.postMedia.findMany.mockResolvedValue([
        {
          id: 'm1',
          postId: 'post-1',
          telegramFileId: 'f1',
          telegramFileUniqueId: 'u1',
          mediaType: MediaType.DOCUMENT,
          fileName: 'recording.mp4',
          mimeType: 'video/mp4',
          sortOrder: 1,
        },
      ]);

      const validation = await mediaService.validateMediaForPost('post-1', videoTemplate);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });
});
