import 'reflect-metadata';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { MediaService } from '../../src/modules/media/media.service';
import {
  isDocumentAsVideo,
  validateMediaGroupCompatibility,
  VIDEO_MIME_TYPES,
  VIDEO_FILE_EXTENSIONS,
} from '../../src/modules/media/utils/media-detector.util';
import { TelegramRenderer } from '../../src/modules/rendering/telegram-renderer.service';
import { HtmlSanitizer } from '../../src/modules/rendering/html-sanitizer.service';
import { MediaType, PostStatus, PostTemplate, PostMedia } from '@prisma/client';
import {
  ValidationException,
  MediaNotFoundException,
  PostConflictException,
  PostNotFoundException,
} from '../../src/common/exceptions/domain.exceptions';
import { AuditAction } from '../../src/common/enums';

/**
 * Empirical Stress Test Suite for Milestone 3 (MediaService & Media Invariants)
 * Executed by m3_challenger_2_r2
 */
describe('Media Module Empirical Challenge & Invariants (m3_challenger_2_r2)', () => {
  let mediaService: MediaService;
  let telegramRenderer: TelegramRenderer;
  let mockPostsRepo: any;
  let mockAuditService: any;
  let mockPermissionService: any;

  // In-memory relational simulation for PostMedia
  interface MediaRecord {
    id: string;
    postId: string;
    telegramFileId: string;
    telegramFileUniqueId: string;
    mediaType: MediaType;
    fileName: string | null;
    mimeType: string | null;
    fileSize: bigint | null;
    caption: string | null;
    sortOrder: number;
    createdAt: Date;
  }

  let dbMediaTable: MediaRecord[] = [];
  let idSequence = 1;

  const createMockPrisma = (): any => ({
    $transaction: jest.fn(async (callback: any) => callback(createMockPrisma())),
    postMedia: {
      count: jest.fn(async ({ where }: { where: { postId: string } }) => {
        return dbMediaTable.filter((m) => m.postId === where.postId).length;
      }),
      findFirst: jest.fn(
        async ({
          where,
          orderBy,
        }: {
          where: { postId: string };
          orderBy?: { sortOrder: 'asc' | 'desc' };
        }) => {
          const items = dbMediaTable.filter((m) => m.postId === where.postId);
          if (orderBy?.sortOrder === 'desc') {
            items.sort((a, b) => b.sortOrder - a.sortOrder);
          } else {
            items.sort((a, b) => a.sortOrder - b.sortOrder);
          }
          return items[0] ? { ...items[0] } : null;
        },
      ),
      findMany: jest.fn(
        async ({
          where,
          orderBy,
        }: {
          where: { postId: string };
          orderBy?: { sortOrder: 'asc' | 'desc' };
        }) => {
          const items = dbMediaTable.filter((m) => m.postId === where.postId);
          if (orderBy?.sortOrder === 'desc') {
            items.sort((a, b) => b.sortOrder - a.sortOrder);
          } else {
            items.sort((a, b) => a.sortOrder - b.sortOrder);
          }
          return items.map((x) => ({ ...x }));
        },
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const item = dbMediaTable.find((m) => m.id === where.id);
        return item ? { ...item } : null;
      }),
      create: jest.fn(async ({ data }: { data: any }) => {
        const record: MediaRecord = {
          id: `media-rec-${idSequence++}`,
          postId: data.postId,
          telegramFileId: data.telegramFileId,
          telegramFileUniqueId: data.telegramFileUniqueId,
          mediaType: data.mediaType,
          fileName: data.fileName ?? null,
          mimeType: data.mimeType ?? null,
          fileSize: data.fileSize ?? null,
          caption: data.caption ?? null,
          sortOrder: data.sortOrder,
          createdAt: new Date(),
        };
        dbMediaTable.push(record);
        return { ...record };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const idx = dbMediaTable.findIndex((m) => m.id === where.id);
        if (idx === -1) throw new Error(`Media not found: ${where.id}`);
        Object.assign(dbMediaTable[idx]!, data);
        return { ...dbMediaTable[idx]! };
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        const idx = dbMediaTable.findIndex((m) => m.id === where.id);
        if (idx === -1) throw new Error(`Media not found: ${where.id}`);
        const [deleted] = dbMediaTable.splice(idx, 1);
        return deleted!;
      }),
      deleteMany: jest.fn(async ({ where }: { where: { postId: string } }) => {
        const initialCount = dbMediaTable.length;
        dbMediaTable = dbMediaTable.filter((m) => m.postId !== where.postId);
        return { count: initialCount - dbMediaTable.length };
      }),
    },
  });

  let basePost: any;

  beforeEach(() => {
    dbMediaTable = [];
    idSequence = 1;

    basePost = {
      id: 'post-empirical-1',
      channelId: 'channel-empirical-1',
      authorId: 'author-empirical-1',
      templateId: 'tpl-photo',
      status: PostStatus.DRAFT,
      version: 1,
      deletedAt: null,
      contentJson: { title: 'Empirical Post', body: 'Empirical Content' },
    };

    const prismaMock = createMockPrisma();

    mockPostsRepo = {
      findById: jest.fn().mockImplementation(async (id: string) => {
        if (id === basePost.id) return { ...basePost };
        return null;
      }),
      updateWithOcc: jest.fn().mockImplementation(async (postId, expectedVersion) => {
        if (expectedVersion !== basePost.version) {
          throw new PostConflictException(postId, expectedVersion, basePost.version);
        }
        basePost.version += 1;
        return { ...basePost };
      }),
    };

    mockAuditService = {
      record: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    };

    mockPermissionService = {
      enforcePostEditPermission: jest.fn().mockResolvedValue(undefined),
    };

    mediaService = new MediaService(
      prismaMock as any,
      mockPostsRepo,
      mockAuditService,
      mockPermissionService,
    );

    const sanitizer = new HtmlSanitizer();
    telegramRenderer = new TelegramRenderer(sanitizer);
  });

  // =========================================================================
  // Invariant 1: Media Group Boundaries & Invariants
  // =========================================================================
  describe('Invariant 1: Media Group Boundaries & Invariants', () => {
    it('1.1 Item count = 1 must NOT be treated as a media group (single media message)', async () => {
      // 1. Validator boundary check
      const singleItem = [{ mediaType: MediaType.PHOTO }];
      const result = validateMediaGroupCompatibility(singleItem);
      expect(result.isValid).toBe(true);
      expect(result.isAlbum).toBe(false);
      expect(result.error).toBeUndefined();

      // 2. Attach single photo to post
      await mediaService.attachMedia(basePost.id, 1, basePost.authorId, {
        telegramFileId: 'tele-single-photo',
        telegramFileUniqueId: 'tele-single-unique',
        mediaType: MediaType.PHOTO,
      });
      expect(dbMediaTable).toHaveLength(1);

      // 3. Renderer check: payload must have type 'photo', NOT 'media_group'
      const template: PostTemplate = {
        id: 'tpl-photo',
        key: 'photo',
        name: 'Фото',
        description: null,
        schemaJson: { fields: [{ key: 'title', type: 'text' }] },
        renderConfig: { layout: '<b>{{title}}</b>' },
        supportedMediaTypes: ['photo', 'media_group'],
        isActive: true,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mediaItems = await mediaService.getMediaForPost(basePost.id);
      const payload = await telegramRenderer.render(basePost as any, template, mediaItems);

      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0]!.type).toBe('photo');
      expect(payload.messages[0]!.type).not.toBe('media_group');
      expect(payload.messages[0]!.fileId).toBe('tele-single-photo');
    });

    it('1.2 Item counts 2..10 must be recognized as valid albums', () => {
      for (let count = 2; count <= 10; count++) {
        const album = Array.from({ length: count }, (_, i) => ({
          mediaType: i % 2 === 0 ? MediaType.PHOTO : MediaType.VIDEO,
        }));
        const result = validateMediaGroupCompatibility(album);
        expect(result.isValid).toBe(true);
        expect(result.isAlbum).toBe(true);
        expect(result.error).toBeUndefined();
      }
    });

    it('1.3 Item count 11+ must be rejected by validator and attachMedia limits', async () => {
      // 1. Validator check on 11 items
      const elevenItems = Array.from({ length: 11 }, () => ({ mediaType: MediaType.PHOTO }));
      const result = validateMediaGroupCompatibility(elevenItems);
      expect(result.isValid).toBe(false);
      expect(result.isAlbum).toBe(true);
      expect(result.error).toContain('не может содержать более 10 элементов');

      // 2. attachMediaBatch rejects exceeding 10 items
      await expect(
        mediaService.attachMediaBatch(
          basePost.id,
          1,
          basePost.authorId,
          elevenItems.map((_, i) => ({
            telegramFileId: `f-${i}`,
            telegramFileUniqueId: `u-${i}`,
            mediaType: MediaType.PHOTO,
          })),
        ),
      ).rejects.toThrow(ValidationException);

      // 3. Sequential attachment: attach 10 items, then attempt 11th
      for (let i = 0; i < 10; i++) {
        await mediaService.attachMedia(basePost.id, basePost.version, basePost.authorId, {
          telegramFileId: `tele-file-${i}`,
          telegramFileUniqueId: `tele-uniq-${i}`,
          mediaType: MediaType.PHOTO,
        });
      }
      expect(dbMediaTable).toHaveLength(10);

      // 11th item must be rejected
      await expect(
        mediaService.attachMedia(basePost.id, basePost.version, basePost.authorId, {
          telegramFileId: 'tele-overflow',
          telegramFileUniqueId: 'tele-overflow-uniq',
          mediaType: MediaType.PHOTO,
        }),
      ).rejects.toThrow(ValidationException);
    });

    it('1.4 Media group type mixing: PHOTO + VIDEO is allowed in Telegram albums', () => {
      const mixed = [
        { mediaType: MediaType.PHOTO },
        { mediaType: MediaType.VIDEO },
        { mediaType: MediaType.PHOTO },
      ];
      const result = validateMediaGroupCompatibility(mixed);
      expect(result.isValid).toBe(true);
      expect(result.isAlbum).toBe(true);
    });

    it('1.5 Media group type mixing: PHOTO + DOCUMENT must be rejected', () => {
      const mixed = [
        { mediaType: MediaType.PHOTO },
        { mediaType: MediaType.DOCUMENT },
      ];
      const result = validateMediaGroupCompatibility(mixed);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Нельзя объединять фото/видео и документы');
    });

    it('1.6 Media group type mixing: VIDEO + DOCUMENT must be rejected', () => {
      const mixed = [
        { mediaType: MediaType.VIDEO },
        { mediaType: MediaType.DOCUMENT },
      ];
      const result = validateMediaGroupCompatibility(mixed);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Нельзя объединять фото/видео и документы');
    });

    it('1.7 Media group type mixing: ANIMATION/GIF in media group must be rejected', () => {
      // Photo + Animation
      expect(
        validateMediaGroupCompatibility([
          { mediaType: MediaType.PHOTO },
          { mediaType: MediaType.ANIMATION },
        ]).isValid,
      ).toBe(false);

      // Video + Animation
      expect(
        validateMediaGroupCompatibility([
          { mediaType: MediaType.VIDEO },
          { mediaType: MediaType.ANIMATION },
        ]).isValid,
      ).toBe(false);

      // Document + Animation
      expect(
        validateMediaGroupCompatibility([
          { mediaType: MediaType.DOCUMENT },
          { mediaType: MediaType.ANIMATION },
        ]).isValid,
      ).toBe(false);

      // Animation + Animation (two GIFs cannot form a Telegram album)
      expect(
        validateMediaGroupCompatibility([
          { mediaType: MediaType.ANIMATION },
          { mediaType: MediaType.ANIMATION },
        ]).isValid,
      ).toBe(false);
    });
  });

  // =========================================================================
  // Invariant 2: Document-as-Video Classification & Transport
  // =========================================================================
  describe('Invariant 2: Document-as-Video Classification & Transport', () => {
    it('2.1 Correctly identifies video documents across various MIME types', () => {
      // Standard video MIME types
      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'video/mp4',
        }),
      ).toBe(true);

      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'video/quicktime',
        }),
      ).toBe(true);

      // Uppercase MIME
      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'VIDEO/MP4',
        }),
      ).toBe(true);

      // Generic video/* prefix
      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'video/x-matroska',
        }),
      ).toBe(true);

      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'video/webm',
        }),
      ).toBe(true);
    });

    it('2.2 Correctly identifies document-as-video with generic application/octet-stream and .mp4 filename', () => {
      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'application/octet-stream',
          fileName: 'presentation_record.mp4',
        }),
      ).toBe(true);

      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'application/octet-stream',
          fileName: 'clip.MOV',
        }),
      ).toBe(true);

      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          fileName: 'raw_recording.mkv',
        }),
      ).toBe(true);
    });

    it('2.3 Rejects non-video documents from video classification', () => {
      const nonVideoFiles = [
        { mimeType: 'application/pdf', fileName: 'contract.pdf' },
        { mimeType: 'application/zip', fileName: 'backup.zip' },
        { mimeType: 'text/plain', fileName: 'notes.txt' },
        { mimeType: 'image/png', fileName: 'screenshot.png' },
        { mimeType: 'application/octet-stream', fileName: 'data.dat' },
      ];

      for (const file of nonVideoFiles) {
        expect(
          isDocumentAsVideo({
            mediaType: MediaType.DOCUMENT,
            mimeType: file.mimeType,
            fileName: file.fileName,
          }),
        ).toBe(false);
      }
    });

    it('2.4 Native PHOTO and VIDEO are NOT document-as-video', () => {
      expect(
        isDocumentAsVideo({
          mediaType: MediaType.VIDEO,
          mimeType: 'video/mp4',
          fileName: 'video.mp4',
        }),
      ).toBe(false);

      expect(
        isDocumentAsVideo({
          mediaType: MediaType.PHOTO,
          mimeType: 'video/mp4',
        }),
      ).toBe(false);
    });

    it('2.5 Enriched media assigns transportMethod sendDocument to document-as-video', async () => {
      await mediaService.attachMedia(basePost.id, 1, basePost.authorId, {
        telegramFileId: 'tele-uncompressed-video-doc',
        telegramFileUniqueId: 'tele-uniq-uncompressed',
        mediaType: MediaType.DOCUMENT,
        fileName: 'drone_4k.mov',
        mimeType: 'video/quicktime',
        fileSize: BigInt(250000000),
      });

      const enriched = await mediaService.getMediaForPost(basePost.id);
      expect(enriched).toHaveLength(1);
      expect(enriched[0]!.isVideoDocument).toBe(true);
      // Invariant: Telegram Bot API rejects document file_id in sendVideo!
      // Must use sendDocument transport method!
      expect(enriched[0]!.transportMethod).toBe('sendDocument');
    });

    it('2.6 Document-as-video cannot be illegally grouped with photos in a media group', async () => {
      const template: PostTemplate = {
        id: 'tpl-photo-group',
        key: 'photo_group',
        name: 'Фотоальбом',
        description: null,
        schemaJson: { fields: [] },
        renderConfig: { layout: 'Album' },
        supportedMediaTypes: ['photo', 'video', 'document', 'media_group'],
        isActive: true,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // 1. Attach 1 photo
      await mediaService.attachMedia(basePost.id, basePost.version, basePost.authorId, {
        telegramFileId: 'tele-photo-item',
        telegramFileUniqueId: 'tele-photo-uniq',
        mediaType: MediaType.PHOTO,
      });

      // 2. Attach 1 document-as-video
      await mediaService.attachMedia(basePost.id, basePost.version, basePost.authorId, {
        telegramFileId: 'tele-doc-video-item',
        telegramFileUniqueId: 'tele-doc-video-uniq',
        mediaType: MediaType.DOCUMENT,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
      });

      // 3. Validation must reject grouping
      const validation = await mediaService.validateMediaForPost(basePost.id, template);
      expect(validation.isValid).toBe(false);
      expect(
        validation.errors.some((err) => err.includes('Нельзя объединять фото/видео и документы')),
      ).toBe(true);
    });
  });

  // =========================================================================
  // Invariant 3: Gapless Sort Order Renormalization
  // =========================================================================
  describe('Invariant 3: Gapless Sort Order Renormalization', () => {
    it('3.1 Attach 5 media items (1..5), delete item #2, verify remaining items have sortOrder [1, 2, 3, 4] without gaps', async () => {
      // 1. Attach 5 items sequentially
      for (let i = 1; i <= 5; i++) {
        await mediaService.attachMedia(basePost.id, basePost.version, basePost.authorId, {
          telegramFileId: `file-id-${i}`,
          telegramFileUniqueId: `uniq-id-${i}`,
          mediaType: MediaType.PHOTO,
        });
      }

      expect(dbMediaTable).toHaveLength(5);
      expect(dbMediaTable.map((m) => m.sortOrder)).toEqual([1, 2, 3, 4, 5]);

      // 2. Delete item #2 (which has sortOrder 2)
      const item2 = dbMediaTable.find((m) => m.sortOrder === 2)!;
      expect(item2).toBeDefined();

      const postAfterDelete = await mediaService.removeMedia(
        basePost.id,
        item2.id,
        basePost.version,
        basePost.authorId,
      );

      // OCC version bumped
      expect(postAfterDelete.version).toBe(7);

      // 3. Invariant: 4 items remain, strictly sortOrder [1, 2, 3, 4]
      expect(dbMediaTable).toHaveLength(4);
      const remainingOrders = dbMediaTable.map((m) => m.sortOrder).sort((a, b) => a - b);
      expect(remainingOrders).toEqual([1, 2, 3, 4]);

      // Verify specific mapping
      const item1 = dbMediaTable.find((m) => m.telegramFileUniqueId === 'uniq-id-1')!;
      const item3 = dbMediaTable.find((m) => m.telegramFileUniqueId === 'uniq-id-3')!;
      const item4 = dbMediaTable.find((m) => m.telegramFileUniqueId === 'uniq-id-4')!;
      const item5 = dbMediaTable.find((m) => m.telegramFileUniqueId === 'uniq-id-5')!;

      expect(item1.sortOrder).toBe(1);
      expect(item3.sortOrder).toBe(2);
      expect(item4.sortOrder).toBe(3);
      expect(item5.sortOrder).toBe(4);
    });

    it('3.2 Sequential deletions from head, middle, and tail always maintain gapless 1..N', async () => {
      // Attach 4 items
      for (let i = 1; i <= 4; i++) {
        await mediaService.attachMedia(basePost.id, basePost.version, basePost.authorId, {
          telegramFileId: `f-${i}`,
          telegramFileUniqueId: `u-${i}`,
          mediaType: MediaType.PHOTO,
        });
      }
      expect(dbMediaTable.map((m) => m.sortOrder)).toEqual([1, 2, 3, 4]);

      // Delete head (item with sortOrder 1)
      const head = dbMediaTable.find((m) => m.sortOrder === 1)!;
      await mediaService.removeMedia(basePost.id, head.id, basePost.version, basePost.authorId);
      expect(dbMediaTable.map((m) => m.sortOrder).sort((a, b) => a - b)).toEqual([1, 2, 3]);

      // Delete tail (item with sortOrder 3)
      const tail = dbMediaTable.find((m) => m.sortOrder === 3)!;
      await mediaService.removeMedia(basePost.id, tail.id, basePost.version, basePost.authorId);
      expect(dbMediaTable.map((m) => m.sortOrder).sort((a, b) => a - b)).toEqual([1, 2]);

      // Attach new item: should take next sequential order (3)
      await mediaService.attachMedia(basePost.id, basePost.version, basePost.authorId, {
        telegramFileId: 'f-new',
        telegramFileUniqueId: 'u-new',
        mediaType: MediaType.PHOTO,
      });
      expect(dbMediaTable.map((m) => m.sortOrder).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    });
  });

  // =========================================================================
  // Invariant 4: Zero-Download Verification
  // =========================================================================
  describe('Invariant 4: Zero-Download Verification & No Side Effects', () => {
    it('4.1 Source code static audit: no filesystem or HTTP client dependencies in media module', () => {
      const mediaServiceSource = fs.readFileSync(
        require.resolve('../../src/modules/media/media.service'),
        'utf-8',
      );
      const detectorSource = fs.readFileSync(
        require.resolve('../../src/modules/media/utils/media-detector.util'),
        'utf-8',
      );

      const forbidden = [
        /\bimport\s+.*\bfrom\s+['"]fs['"]/,
        /\bimport\s+.*\bfrom\s+['"]node:fs['"]/,
        /\bimport\s+.*\bfrom\s+['"]http['"]/,
        /\bimport\s+.*\bfrom\s+['"]https['"]/,
        /\bimport\s+.*\bfrom\s+['"]node:http['"]/,
        /\bimport\s+.*\bfrom\s+['"]node:https['"]/,
        /\bimport\s+.*\bfrom\s+['"]axios['"]/,
        /\bimport\s+.*\bfrom\s+['"]got['"]/,
        /\bimport\s+.*\bfrom\s+['"]node-fetch['"]/,
        /\bwriteFile\b/,
        /\bwriteFileSync\b/,
        /\bcreateWriteStream\b/,
        /\baxios\b/,
        /\bfetch\(/,
      ];

      for (const pattern of forbidden) {
        expect(mediaServiceSource).not.toMatch(pattern);
        expect(detectorSource).not.toMatch(pattern);
      }
    });

    it('4.2 Runtime inspection: operations execute in-memory with zero network or filesystem activity', async () => {
      let fetchSpy: jest.SpyInstance | undefined;
      if (typeof globalThis.fetch === 'function') {
        fetchSpy = jest.spyOn(globalThis, 'fetch');
      }

      try {
        const t0 = Date.now();

        // 1. attachMedia
        await mediaService.attachMedia(basePost.id, basePost.version, basePost.authorId, {
          telegramFileId: 'AgACAgIAAxkBAAI9876',
          telegramFileUniqueId: 'unique_tele_photo_1',
          mediaType: MediaType.PHOTO,
          fileSize: BigInt(512000),
        });

        // 2. attachMediaBatch
        await mediaService.attachMediaBatch(basePost.id, basePost.version, basePost.authorId, [
          {
            telegramFileId: 'BAACAgIAAxkBAAI9877',
            telegramFileUniqueId: 'unique_tele_video_2',
            mediaType: MediaType.VIDEO,
            fileSize: BigInt(15000000),
          },
        ]);

        // 3. getMediaForPost
        const enriched = await mediaService.getMediaForPost(basePost.id);
        expect(enriched).toHaveLength(2);

        // 4. removeMedia
        await mediaService.removeMedia(basePost.id, dbMediaTable[0]!.id, basePost.version, basePost.authorId);

        const elapsed = Date.now() - t0;

        // Invariant: zero fetch calls
        if (fetchSpy) {
          expect(fetchSpy).not.toHaveBeenCalled();
        }

        // Invariant: fast in-memory execution (< 100ms)
        expect(elapsed).toBeLessThan(100);

        // Invariant: stored entities contain only remote string IDs, no binary buffers
        for (const row of dbMediaTable) {
          expect(typeof row.telegramFileId).toBe('string');
          expect(typeof row.telegramFileUniqueId).toBe('string');
          expect((row as any).buffer).toBeUndefined();
          expect((row as any).data).toBeUndefined();
        }
      } finally {
        if (fetchSpy) {
          fetchSpy.mockRestore();
        }
      }
    });
  });

  // =========================================================================
  // Invariant 5: Concurrency, Permissions & State Invariants
  // =========================================================================
  describe('Invariant 5: Concurrency, Permissions & State Invariants', () => {
    it('5.1 Rejects attachment if post is not in editable status (e.g. PUBLISHED or PENDING_REVIEW)', async () => {
      mockPostsRepo.findById.mockResolvedValueOnce({
        ...basePost,
        status: PostStatus.PUBLISHED,
      });

      await expect(
        mediaService.attachMedia(basePost.id, 1, basePost.authorId, {
          telegramFileId: 'f1',
          telegramFileUniqueId: 'u1',
          mediaType: MediaType.PHOTO,
        }),
      ).rejects.toThrow(ValidationException);
    });

    it('5.2 Rejects attachment if post is soft-deleted', async () => {
      mockPostsRepo.findById.mockResolvedValueOnce({
        ...basePost,
        deletedAt: new Date(),
      });

      await expect(
        mediaService.attachMedia(basePost.id, 1, basePost.authorId, {
          telegramFileId: 'f1',
          telegramFileUniqueId: 'u1',
          mediaType: MediaType.PHOTO,
        }),
      ).rejects.toThrow(PostNotFoundException);
    });

    it('5.3 Concurrency: version conflict during attachMedia throws PostConflictException', async () => {
      // Pass wrong expectedVersion (e.g. 99 vs 1)
      await expect(
        mediaService.attachMedia(basePost.id, 99, basePost.authorId, {
          telegramFileId: 'f1',
          telegramFileUniqueId: 'u1',
          mediaType: MediaType.PHOTO,
        }),
      ).rejects.toThrow(PostConflictException);
    });

    it('5.4 Reordering media updates sortOrder and bumps version', async () => {
      // Attach 2 items
      await mediaService.attachMedia(basePost.id, basePost.version, basePost.authorId, {
        telegramFileId: 'f1',
        telegramFileUniqueId: 'u1',
        mediaType: MediaType.PHOTO,
      });
      await mediaService.attachMedia(basePost.id, basePost.version, basePost.authorId, {
        telegramFileId: 'f2',
        telegramFileUniqueId: 'u2',
        mediaType: MediaType.PHOTO,
      });

      const m1 = dbMediaTable[0]!;
      const m2 = dbMediaTable[1]!;

      // Swap sortOrders: m1 -> 2, m2 -> 1
      const updatedPost = await mediaService.reorderMedia(
        basePost.id,
        [
          { mediaId: m1.id, sortOrder: 2 },
          { mediaId: m2.id, sortOrder: 1 },
        ],
        basePost.version,
        basePost.authorId,
      );

      expect(updatedPost.version).toBe(4);
      expect(dbMediaTable.find((m) => m.id === m1.id)!.sortOrder).toBe(2);
      expect(dbMediaTable.find((m) => m.id === m2.id)!.sortOrder).toBe(1);
    });

    it('5.5 Clear media deletes all attachments and bumps version', async () => {
      await mediaService.attachMedia(basePost.id, basePost.version, basePost.authorId, {
        telegramFileId: 'f1',
        telegramFileUniqueId: 'u1',
        mediaType: MediaType.PHOTO,
      });
      expect(dbMediaTable).toHaveLength(1);

      await mediaService.clearMedia(basePost.id, basePost.version, basePost.authorId);
      expect(dbMediaTable).toHaveLength(0);
    });
  });
});
