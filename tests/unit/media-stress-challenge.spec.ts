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
} from '../../src/common/exceptions/domain.exceptions';

describe('Media Module Empirical Stress Testing & Adversarial Challenges', () => {
  let mediaService: MediaService;
  let telegramRenderer: TelegramRenderer;
  let mockPostsRepo: any;
  let mockAuditService: any;
  let mockPermissionService: any;

  // In-memory simulated database table for postMedia
  interface MediaRow {
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
  }

  let dbMediaTable: MediaRow[] = [];
  let nextIdCounter = 1;

  const createSimulatedPrisma = (): any => ({
    $transaction: jest.fn(async (cb: any) => cb(createSimulatedPrisma())),
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
          return items[0] || null;
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
        const found = dbMediaTable.find((m) => m.id === where.id);
        return found ? { ...found } : null;
      }),
      create: jest.fn(async ({ data }: { data: any }) => {
        const newRecord: MediaRow = {
          id: `media-${nextIdCounter++}`,
          postId: data.postId,
          telegramFileId: data.telegramFileId,
          telegramFileUniqueId: data.telegramFileUniqueId,
          mediaType: data.mediaType,
          fileName: data.fileName ?? null,
          mimeType: data.mimeType ?? null,
          fileSize: data.fileSize ?? null,
          caption: data.caption ?? null,
          sortOrder: data.sortOrder,
        };
        dbMediaTable.push(newRecord);
        return { ...newRecord };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const item = dbMediaTable.find((m) => m.id === where.id);
        if (!item) throw new Error(`Not found: ${where.id}`);
        Object.assign(item, data);
        return { ...item };
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        const idx = dbMediaTable.findIndex((m) => m.id === where.id);
        if (idx === -1) throw new Error(`Not found: ${where.id}`);
        const [deleted] = dbMediaTable.splice(idx, 1);
        return deleted;
      }),
      deleteMany: jest.fn(async ({ where }: { where: { postId: string } }) => {
        const before = dbMediaTable.length;
        dbMediaTable = dbMediaTable.filter((m) => m.postId !== where.postId);
        return { count: before - dbMediaTable.length };
      }),
    },
  });

  const basePost = {
    id: 'post-test-1',
    channelId: 'channel-test-1',
    authorId: 'author-test-1',
    templateId: 'tpl-test-1',
    status: PostStatus.DRAFT,
    version: 1,
    deletedAt: null,
    contentJson: { title: 'Test Post', body: 'Test Content' },
  };

  beforeEach(() => {
    dbMediaTable = [];
    nextIdCounter = 1;

    const simulatedPrisma = createSimulatedPrisma();

    mockPostsRepo = {
      findById: jest.fn().mockResolvedValue({ ...basePost }),
      updateWithOcc: jest.fn().mockImplementation(async (postId, expectedVersion) => ({
        ...basePost,
        version: expectedVersion + 1,
      })),
    };

    mockAuditService = {
      record: jest.fn().mockResolvedValue({ id: 'audit-log-1' }),
    };

    mockPermissionService = {
      enforcePostEditPermission: jest.fn().mockResolvedValue(undefined),
    };

    mediaService = new MediaService(
      simulatedPrisma as any,
      mockPostsRepo,
      mockAuditService,
      mockPermissionService,
    );

    const sanitizer = new HtmlSanitizer();
    telegramRenderer = new TelegramRenderer(sanitizer);
  });

  // =========================================================================
  // 1. Media Group Boundaries & Invariants
  // =========================================================================
  describe('1. Media Group Boundaries & Invariants', () => {
    it('Single item (count = 1): must NOT be treated as a media group', async () => {
      const singlePhoto = [{ mediaType: MediaType.PHOTO }];
      const validation = validateMediaGroupCompatibility(singlePhoto);

      // Invariant: 1 item is valid, but is NOT an album
      expect(validation.isValid).toBe(true);
      expect(validation.isAlbum).toBe(false);
      expect(validation.error).toBeUndefined();

      // Renderer check: 1 item rendered as single photo, NOT media_group
      const mediaItem: PostMedia = {
        id: 'm-1',
        postId: basePost.id,
        telegramFileId: 'file-single-photo',
        telegramFileUniqueId: 'u-single-photo',
        mediaType: MediaType.PHOTO,
        fileName: null,
        mimeType: null,
        fileSize: null,
        caption: null,
        sortOrder: 1,
        createdAt: new Date(),
      };

      const template: PostTemplate = {
        id: 'tpl-1',
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

      const payload = await telegramRenderer.render(basePost as any, template, [mediaItem]);
      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0]!.type).toBe('photo');
      expect(payload.messages[0]!.type).not.toBe('media_group');
      expect(payload.messages[0]!.fileId).toBe('file-single-photo');
    });

    it('Valid album counts (2 to 10 items): must be accepted as valid album', () => {
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

    it('Exceeding album count (11+ items): must be rejected by compatibility validator and attachMedia', async () => {
      // 1. Compatibility check rejects 11 items
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
            telegramFileId: `file-${i}`,
            telegramFileUniqueId: `uniq-${i}`,
            mediaType: MediaType.PHOTO,
          })),
        ),
      ).rejects.toThrow(ValidationException);

      // 3. Sequential attachMedia rejects the 11th item when 10 already exist
      for (let i = 0; i < 10; i++) {
        await mediaService.attachMedia(basePost.id, i + 1, basePost.authorId, {
          telegramFileId: `f-${i}`,
          telegramFileUniqueId: `u-${i}`,
          mediaType: MediaType.PHOTO,
        });
      }
      expect(dbMediaTable).toHaveLength(10);

      // Attempting to attach the 11th item must throw ValidationException
      await expect(
        mediaService.attachMedia(basePost.id, 11, basePost.authorId, {
          telegramFileId: 'f-11-overflow',
          telegramFileUniqueId: 'u-11-overflow',
          mediaType: MediaType.PHOTO,
        }),
      ).rejects.toThrow(ValidationException);
    });

    it('Type mixing: PHOTO + VIDEO is allowed in Telegram albums', () => {
      const mixedPhotoVideo = [
        { mediaType: MediaType.PHOTO },
        { mediaType: MediaType.VIDEO },
        { mediaType: MediaType.PHOTO },
        { mediaType: MediaType.VIDEO },
      ];
      const result = validateMediaGroupCompatibility(mixedPhotoVideo);
      expect(result.isValid).toBe(true);
      expect(result.isAlbum).toBe(true);
    });

    it('Type mixing: PHOTO + DOCUMENT must be rejected', () => {
      const mixedPhotoDoc = [
        { mediaType: MediaType.PHOTO },
        { mediaType: MediaType.DOCUMENT },
      ];
      const result = validateMediaGroupCompatibility(mixedPhotoDoc);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Нельзя объединять фото/видео и документы');
    });

    it('Type mixing: VIDEO + DOCUMENT must be rejected', () => {
      const mixedVideoDoc = [
        { mediaType: MediaType.VIDEO },
        { mediaType: MediaType.DOCUMENT },
      ];
      const result = validateMediaGroupCompatibility(mixedVideoDoc);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Нельзя объединять фото/видео и документы');
    });

    it('Type mixing: ANIMATION/GIF in media group must be rejected', () => {
      // Photo + Animation
      const photoWithGif = [
        { mediaType: MediaType.PHOTO },
        { mediaType: MediaType.ANIMATION },
      ];
      expect(validateMediaGroupCompatibility(photoWithGif).isValid).toBe(false);
      expect(validateMediaGroupCompatibility(photoWithGif).error).toContain('GIF-анимации нельзя объединять');

      // Video + Animation
      const videoWithGif = [
        { mediaType: MediaType.VIDEO },
        { mediaType: MediaType.ANIMATION },
      ];
      expect(validateMediaGroupCompatibility(videoWithGif).isValid).toBe(false);

      // Animation + Animation (even two GIFs cannot form a media group in Telegram)
      const twoGifs = [
        { mediaType: MediaType.ANIMATION },
        { mediaType: MediaType.ANIMATION },
      ];
      expect(validateMediaGroupCompatibility(twoGifs).isValid).toBe(false);
      expect(validateMediaGroupCompatibility(twoGifs).error).toContain('GIF-анимации нельзя объединять');
    });
  });

  // =========================================================================
  // 2. Document-as-Video Classification & Invariants
  // =========================================================================
  describe('2. Document-as-Video Classification & Invariants', () => {
    it('Should correctly classify all known video MIME types as document-as-video', () => {
      for (const mime of VIDEO_MIME_TYPES) {
        const detected = isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: mime,
        });
        expect(detected).toBe(true);
      }
    });

    it('Should detect any arbitrary video/* MIME type (e.g. video/ogg, video/webm, video/custom)', () => {
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

      expect(
        isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'video/x-unknown-new-format',
        }),
      ).toBe(true);
    });

    it('Should detect document-as-video when MIME is generic octet-stream but filename has video extension', () => {
      for (const ext of VIDEO_FILE_EXTENSIONS) {
        const detected = isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: 'application/octet-stream',
          fileName: `uncompressed_clip.${ext}`,
        });
        expect(detected).toBe(true);
      }
    });

    it('Should reject non-video documents from being classified as video', () => {
      const nonVideos = [
        { mimeType: 'application/pdf', fileName: 'report.pdf' },
        { mimeType: 'application/zip', fileName: 'archive.zip' },
        { mimeType: 'text/plain', fileName: 'notes.txt' },
        { mimeType: 'image/jpeg', fileName: 'photo.jpg' },
        { mimeType: 'application/vnd.ms-excel', fileName: 'sheet.xls' },
        { mimeType: 'application/octet-stream', fileName: 'binary.dat' },
      ];

      for (const item of nonVideos) {
        const detected = isDocumentAsVideo({
          mediaType: MediaType.DOCUMENT,
          mimeType: item.mimeType,
          fileName: item.fileName,
        });
        expect(detected).toBe(false);
      }
    });

    it('Should NOT classify native PHOTO or VIDEO as document-as-video', () => {
      expect(
        isDocumentAsVideo({
          mediaType: MediaType.VIDEO,
          mimeType: 'video/mp4',
          fileName: 'clip.mp4',
        }),
      ).toBe(false);

      expect(
        isDocumentAsVideo({
          mediaType: MediaType.PHOTO,
          mimeType: 'video/mp4',
        }),
      ).toBe(false);
    });

    it('Enrichment: document-as-video must have transportMethod sendDocument', async () => {
      await mediaService.attachMedia(basePost.id, 1, basePost.authorId, {
        telegramFileId: 'file-doc-video-4k',
        telegramFileUniqueId: 'uniq-doc-video-4k',
        mediaType: MediaType.DOCUMENT,
        fileName: 'prores_master.mov',
        mimeType: 'video/quicktime',
        fileSize: 450000000,
      });

      const enriched = await mediaService.getMediaForPost(basePost.id);
      expect(enriched).toHaveLength(1);
      expect(enriched[0]!.isVideoDocument).toBe(true);
      // Critical invariant: Bot API rejects passing document file_id to sendVideo!
      // Must use sendDocument transport method.
      expect(enriched[0]!.transportMethod).toBe('sendDocument');
    });

    it('Invariant: document-as-video cannot be illegally grouped with photos in a media group', async () => {
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

      // Attach 1 photo
      await mediaService.attachMedia(basePost.id, 1, basePost.authorId, {
        telegramFileId: 'f-photo-1',
        telegramFileUniqueId: 'u-photo-1',
        mediaType: MediaType.PHOTO,
      });

      // Attach 1 document-as-video
      await mediaService.attachMedia(basePost.id, 2, basePost.authorId, {
        telegramFileId: 'f-doc-vid-1',
        telegramFileUniqueId: 'u-doc-vid-1',
        mediaType: MediaType.DOCUMENT,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
      });

      // Validation must fail: Cannot group photo and document
      const validation = await mediaService.validateMediaForPost(basePost.id, template);
      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('Нельзя объединять фото/видео и документы'))).toBe(true);
    });
  });

  // =========================================================================
  // 3. Gapless Sort Order Renormalization
  // =========================================================================
  describe('3. Gapless Sort Order Renormalization', () => {
    it('Should attach 5 media items (1..5), delete item #2, and verify remaining items are [1, 2, 3, 4] without gaps', async () => {
      // 1. Attach 5 items
      for (let i = 1; i <= 5; i++) {
        await mediaService.attachMedia(basePost.id, i, basePost.authorId, {
          telegramFileId: `file-seq-${i}`,
          telegramFileUniqueId: `uniq-seq-${i}`,
          mediaType: MediaType.PHOTO,
        });
      }

      // Verify all 5 attached in order
      expect(dbMediaTable).toHaveLength(5);
      expect(dbMediaTable.map((m) => m.sortOrder)).toEqual([1, 2, 3, 4, 5]);

      // Identify item #2 (which has sortOrder 2)
      const item2 = dbMediaTable.find((m) => m.sortOrder === 2)!;
      expect(item2).toBeDefined();

      // 2. Remove item #2
      const postAfterRemove = await mediaService.removeMedia(
        basePost.id,
        item2.id,
        6,
        basePost.authorId,
      );

      // OCC version bumped
      expect(postAfterRemove.version).toBe(7);

      // 3. Invariant: 4 items remain, and their sortOrders are strictly [1, 2, 3, 4]
      expect(dbMediaTable).toHaveLength(4);
      const remainingOrders = dbMediaTable.map((m) => m.sortOrder).sort((a, b) => a - b);
      expect(remainingOrders).toEqual([1, 2, 3, 4]);

      // Verify mapping: former items 1, 3, 4, 5 now have orders 1, 2, 3, 4
      const former1 = dbMediaTable.find((m) => m.telegramFileUniqueId === 'uniq-seq-1')!;
      const former3 = dbMediaTable.find((m) => m.telegramFileUniqueId === 'uniq-seq-3')!;
      const former4 = dbMediaTable.find((m) => m.telegramFileUniqueId === 'uniq-seq-4')!;
      const former5 = dbMediaTable.find((m) => m.telegramFileUniqueId === 'uniq-seq-5')!;

      expect(former1.sortOrder).toBe(1);
      expect(former3.sortOrder).toBe(2);
      expect(former4.sortOrder).toBe(3);
      expect(former5.sortOrder).toBe(4);
    });

    it('Boundary: Deleting item #1 (head) should renumber remaining to [1, 2, 3]', async () => {
      // We have 4 items: orders 1, 2, 3, 4
      for (let i = 1; i <= 4; i++) {
        await mediaService.attachMedia(basePost.id, i, basePost.authorId, {
          telegramFileId: `file-head-${i}`,
          telegramFileUniqueId: `uniq-head-${i}`,
          mediaType: MediaType.PHOTO,
        });
      }

      const item1 = dbMediaTable.find((m) => m.sortOrder === 1)!;
      await mediaService.removeMedia(basePost.id, item1.id, 5, basePost.authorId);

      expect(dbMediaTable).toHaveLength(3);
      const remainingOrders = dbMediaTable.map((m) => m.sortOrder).sort((a, b) => a - b);
      expect(remainingOrders).toEqual([1, 2, 3]);
    });

    it('Boundary: Deleting the last item (tail) should leave remaining intact [1, 2, 3]', async () => {
      for (let i = 1; i <= 4; i++) {
        await mediaService.attachMedia(basePost.id, i, basePost.authorId, {
          telegramFileId: `file-tail-${i}`,
          telegramFileUniqueId: `uniq-tail-${i}`,
          mediaType: MediaType.PHOTO,
        });
      }

      const lastItem = dbMediaTable.find((m) => m.sortOrder === 4)!;
      await mediaService.removeMedia(basePost.id, lastItem.id, 5, basePost.authorId);

      expect(dbMediaTable).toHaveLength(3);
      const remainingOrders = dbMediaTable.map((m) => m.sortOrder).sort((a, b) => a - b);
      expect(remainingOrders).toEqual([1, 2, 3]);
    });

    it('Boundary: Deleting the only item leaves empty table [ ]', async () => {
      await mediaService.attachMedia(basePost.id, 1, basePost.authorId, {
        telegramFileId: 'f-only',
        telegramFileUniqueId: 'u-only',
        mediaType: MediaType.PHOTO,
      });

      const onlyItem = dbMediaTable[0]!;
      await mediaService.removeMedia(basePost.id, onlyItem.id, 2, basePost.authorId);

      expect(dbMediaTable).toHaveLength(0);
    });
  });

  // =========================================================================
  // 4. Zero-Download Verification
  // =========================================================================
  describe('4. Zero-Download Verification & No Side Effects', () => {
    it('Static Code Invariant: Media module source code MUST NOT import or reference filesystem or HTTP clients', () => {
      const mediaServiceCode = fs.readFileSync(
        require.resolve('../../src/modules/media/media.service'),
        'utf-8',
      );
      const detectorCode = fs.readFileSync(
        require.resolve('../../src/modules/media/utils/media-detector.util'),
        'utf-8',
      );

      const forbiddenPatterns = [
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

      for (const pattern of forbiddenPatterns) {
        expect(mediaServiceCode).not.toMatch(pattern);
        expect(detectorCode).not.toMatch(pattern);
      }
    });

    it('Runtime Invariant: MediaService operations must persist file_id directly without any network calls or binary buffers', async () => {
      let fetchSpy: jest.SpyInstance | undefined;
      if (typeof globalThis.fetch === 'function') {
        fetchSpy = jest.spyOn(globalThis, 'fetch');
      }

      try {
        const startTime = Date.now();

        // 1. Attach single media
        await mediaService.attachMedia(basePost.id, 1, basePost.authorId, {
          telegramFileId: 'BQACAgIAAxkBAAI5678',
          telegramFileUniqueId: 'unique_tele_789',
          mediaType: MediaType.VIDEO,
          fileName: 'clip.mp4',
          mimeType: 'video/mp4',
          fileSize: 10485760,
        });

        // 2. Attach batch
        await mediaService.attachMediaBatch(basePost.id, 2, basePost.authorId, [
          {
            telegramFileId: 'BQACAgIAAxkBAAI9999',
            telegramFileUniqueId: 'unique_tele_999',
            mediaType: MediaType.PHOTO,
          },
        ]);

        // 3. Get enriched media
        const enriched = await mediaService.getMediaForPost(basePost.id);
        expect(enriched).toHaveLength(2);

        // 4. Validate media for post
        const template: PostTemplate = {
          id: 'tpl-video',
          key: 'video',
          name: 'Видео',
          description: null,
          schemaJson: { fields: [] },
          renderConfig: { layout: 'Vid' },
          supportedMediaTypes: ['photo', 'video', 'media_group'],
          isActive: true,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await mediaService.validateMediaForPost(basePost.id, template);

        // 5. Remove media
        await mediaService.removeMedia(basePost.id, dbMediaTable[0]!.id, 3, basePost.authorId);

        const duration = Date.now() - startTime;

        // Invariant 1: If fetch was available in runtime, zero fetch calls were made
        if (fetchSpy) {
          expect(fetchSpy).not.toHaveBeenCalled();
        }

        // Invariant 2: Execution was completely synchronous/in-memory (under 100ms for 5 operations)
        expect(duration).toBeLessThan(100);

        // Invariant 3: Persisted records contain only remote Telegram string IDs, zero binary blobs/buffers
        for (const row of dbMediaTable) {
          expect(typeof row.telegramFileId).toBe('string');
          expect(typeof row.telegramFileUniqueId).toBe('string');
          expect((row as any).buffer).toBeUndefined();
          expect((row as any).data).toBeUndefined();
          expect((row as any).content).toBeUndefined();
        }

        expect(dbMediaTable[0]!.telegramFileId).toBe('BQACAgIAAxkBAAI9999');
        expect(dbMediaTable[0]!.telegramFileUniqueId).toBe('unique_tele_999');
      } finally {
        if (fetchSpy) {
          fetchSpy.mockRestore();
        }
      }
    });
  });
});
