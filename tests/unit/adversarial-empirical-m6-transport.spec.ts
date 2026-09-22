import 'reflect-metadata';
import { Post, PostTemplate, PostMedia, MediaType, PostStatus, PublicationJobStatus, Channel } from '@prisma/client';
import { Queue } from 'bullmq';
import { HtmlSanitizer } from '../../src/modules/rendering/html-sanitizer.service';
import { HtmlSplitter } from '../../src/modules/rendering/html-splitter';
import { TelegramRenderer } from '../../src/modules/rendering/telegram-renderer.service';
import { TELEGRAM_LIMITS } from '../../src/common/constants/telegram-limits';
import { PostWizardService } from '../../src/modules/telegram/services/post-wizard.service';
import { DraftManagerService } from '../../src/modules/telegram/services/draft-manager.service';
import { MediaService } from '../../src/modules/media/media.service';
import { isDocumentAsVideo, validateMediaGroupCompatibility } from '../../src/modules/media/utils/media-detector.util';
import { SchedulingService } from '../../src/modules/scheduling/scheduling.service';
import {
  parseAndValidateScheduledDate,
  formatChannelDate,
  DEFAULT_CHANNEL_TIMEZONE,
} from '../../src/modules/channels/utils/timezone.util';
import {
  ValidationException,
  PermissionDeniedException,
  PostConflictException,
  InvalidPostStateTransitionException,
} from '../../src/common/exceptions/domain.exceptions';
import { ChannelPermission, PostAction, AuditAction } from '../../src/common/enums';
import { TemplateValidator } from '../../src/modules/templates/template.validator';
import { TemplateSchema } from '../../src/modules/templates/interfaces/template.interface';
import { AttachMediaDto } from '../../src/modules/media/dto/attach-media.dto';
import { JOB_NAMES } from '../../src/common/constants/queue-names';

/**
 * Milestone 6 Phase 2: Tier 5 Adversarial Coverage Hardening
 * Telegram Transport, Interactive Wizard, Rendering, Media & Scheduling Track.
 *
 * White-box adversarial challenge suite authored by m6_challenger_2.
 */
describe('Milestone 6 Adversarial Empirical Suite (m6_challenger_2)', () => {
  // =========================================================================
  // Track 1: Complex HTML Splitting & Tag Preservation Boundaries
  // =========================================================================
  describe('Track 1: Complex HTML Splitting & Tag Preservation Boundaries', () => {
    let sanitizer: HtmlSanitizer;
    let renderer: TelegramRenderer;

    beforeEach(() => {
      sanitizer = new HtmlSanitizer();
      renderer = new TelegramRenderer(sanitizer);
    });

    it('1.1 should split deeply nested HTML (7 layers) respecting maxLength and preserving reverse-LIFO close & FIFO reopen', () => {
      // 7 levels of nesting: blockquote > pre > code > b > i > u > s
      const openTags = '<blockquote><pre><code><b><i><u><s>';
      const closeTags = '</s></u></i></b></code></pre></blockquote>';
      const bodyWords = 'DeeplyNestedContent '.repeat(80); // ~1600 chars
      const fullHtml = `${openTags}${bodyWords}${closeTags}`;

      const { part1, part2 } = HtmlSplitter.splitHtml(fullHtml, 1024);

      // Part 1 length must strictly obey 1024 limit including closing suffix
      expect(part1.length).toBeLessThanOrEqual(1024);
      expect(part1.startsWith('<blockquote><pre><code><b><i><u><s>')).toBe(true);
      expect(part1.endsWith('</s></u></i></b></code></pre></blockquote>')).toBe(true);

      // Part 2 must reopen all active tags in exact order
      expect(part2).toBeDefined();
      expect(part2!.startsWith('<blockquote><pre><code><b><i><u><s>')).toBe(true);
      expect(part2!.endsWith('</s></u></i></b></code></pre></blockquote>')).toBe(true);

      // Both parts must be valid HTML with zero unbalanced tags
      expect(sanitizer.sanitize(part1)).toBe(part1);
      expect(sanitizer.sanitize(part2!)).toBe(part2);
    });

    it('1.2 should preserve complex anchor tag attributes (URL + query params) across split boundary', () => {
      const complexUrl = 'https://news.example.com/item?id=987654&amp;filter=all&amp;ref=telegram';
      const openTag = `<a href="${complexUrl}"><b>`;
      const closeTag = '</b></a>';
      const longText = 'EditorialArticleHeadlineAndParagraph '.repeat(40); // ~1480 chars
      const input = `${openTag}${longText}${closeTag}`;

      const { part1, part2 } = HtmlSplitter.splitHtml(input, 1024);

      expect(part1.length).toBeLessThanOrEqual(1024);
      expect(part1.startsWith(`<a href="${complexUrl}"><b>`)).toBe(true);
      expect(part1.endsWith('</b></a>')).toBe(true);

      expect(part2).toBeDefined();
      expect(part2!.startsWith(`<a href="${complexUrl}"><b>`)).toBe(true);
      expect(part2!.endsWith('</b></a>')).toBe(true);
    });

    it('1.3 should never slice through HTML entities (&quot;, &amp;, &lt;, &gt;, &#1234;) near split boundary', () => {
      // Position an entity right across the safeLimit boundary
      const fillLength = 1018;
      const prefix = 'A'.repeat(fillLength);
      const input = `${prefix}&quot;SuffixWord`; // entity starts at index 1018, ends at 1024

      const { part1, part2 } = HtmlSplitter.splitHtml(input, 1021); // limit cuts inside &quot;

      expect(part1).not.toContain('&q');
      expect(part1).not.toContain('&qu');
      expect(part1).not.toContain('&quo');
      expect(part1).not.toContain('&quot');
      // Entity must be either wholly preserved or deferred to part2
      if (part1.includes('&quot;')) {
        expect(part1.endsWith('&quot;') || part1.endsWith('SuffixWord')).toBe(true);
      } else {
        expect(part2).toContain('&quot;');
      }
    });

    it('1.4 should never cut inside an HTML tag header (<blockquote class="...">)', () => {
      const prefix = 'Intro '.repeat(190); // ~1140 chars
      const tagWithAttrs = '<blockquote class="editor-quote">';
      const text = 'Important statement inside blockquote.';
      const close = '</blockquote>';
      const input = `${prefix}${tagWithAttrs}${text}${close}`;

      const { part1, part2 } = HtmlSplitter.splitHtml(input, prefix.length + 10);

      // Part 1 must not end with a partial tag like '<block' or '<blockquote class='
      expect(part1).not.toMatch(/<[^>]*$/);
      // The tag should cleanly appear in part2 if not completed in part1
      expect(part2).toBeDefined();
    });

    it('1.5 should handle massive unbroken string (5500 chars) with tags without infinite recursion or exceeding limit', () => {
      const unbrokenToken = 'Z'.repeat(5500);
      const html = `<b><i>${unbrokenToken}</i></b>`;

      const chunks = HtmlSplitter.splitIntoChunks(html, 4096);

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4096);
      }
      expect(chunks[0]!.startsWith('<b><i>')).toBe(true);
      expect(chunks[0]!.endsWith('</i></b>')).toBe(true);
      expect(chunks[1]!.startsWith('<b><i>')).toBe(true);
      expect(chunks[1]!.endsWith('</i></b>')).toBe(true);
    });

    it('1.6 should split a 12,000 character document into balanced chunks all <= 4096 with zero dropped words', () => {
      const paragraph = '<b>Editorial deep dive paragraph.</b> <i>Analysis continues with details.</i>\n\n';
      const doc = paragraph.repeat(150); // ~12,300 chars

      const chunks = HtmlSplitter.splitIntoChunks(doc, 4096);

      expect(chunks.length).toBeGreaterThanOrEqual(3);
      let totalLength = 0;
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4096);
        totalLength += chunk.length;
        // Verify tag balancing on every chunk
        const reSanitized = sanitizer.sanitize(chunk);
        expect(reSanitized).toBe(chunk);
      }

      // Plain text reconstruction must contain all content
      const plainReconstructed = chunks.map((c) => sanitizer.stripAllTags(c)).join(' ');
      expect(plainReconstructed).toContain('Editorial deep dive paragraph.');
      expect(plainReconstructed).toContain('Analysis continues with details.');
    });

    it('1.7 should handle exact boundary conditions (1024, 1025, 4096, 4097 chars)', () => {
      // Exactly 1024 plain text chars
      const text1024 = 'W'.repeat(1024);
      const res1024 = HtmlSplitter.splitHtml(text1024, 1024);
      expect(res1024.part1.length).toBe(1024);
      expect(res1024.part2).toBeUndefined();

      // Exactly 1025 chars -> must split!
      const text1025 = 'W'.repeat(1025);
      const res1025 = HtmlSplitter.splitHtml(text1025, 1024);
      expect(res1025.part1.length).toBeLessThanOrEqual(1024);
      expect(res1025.part2).toBeDefined();
      expect(res1025.part1.length + res1025.part2!.length).toBe(1025);

      // Exactly 4096 plain text chars
      const text4096 = 'M'.repeat(4096);
      const chunks4096 = HtmlSplitter.splitIntoChunks(text4096, 4096);
      expect(chunks4096).toHaveLength(1);
      expect(chunks4096[0]!.length).toBe(4096);

      // Exactly 4097 chars -> 2 chunks
      const text4097 = 'M'.repeat(4097);
      const chunks4097 = HtmlSplitter.splitIntoChunks(text4097, 4096);
      expect(chunks4097).toHaveLength(2);
      expect(chunks4097[0]!.length).toBeLessThanOrEqual(4096);
      expect(chunks4097[1]!.length).toBeLessThanOrEqual(4096);
    });

    it('1.8 should render post with single photo and 1500 char caption into photo (<=1024) + text message (<=4096)', async () => {
      const template: PostTemplate = {
        id: 'tpl-photo-adv',
        key: 'photo_adv',
        name: 'Photo Adv',
        description: 'Photo post',
        schemaJson: {
          fields: [{ key: 'body', label: 'Body', type: 'rich_text', required: true }],
        } as any,
        renderConfig: { layout: '{{body}}' } as any,
        supportedMediaTypes: ['photo'],
        version: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const longCaption = '<b>Key observation:</b> ' + 'Important editorial context sentence. '.repeat(45); // ~1800 chars
      const post: Post = {
        id: 'post-split-p1',
        channelId: 'chan-1',
        authorId: 'auth-1',
        templateId: 'tpl-photo-adv',
        templateVersion: 1,
        status: PostStatus.APPROVED,
        version: 1,
        contentJson: { body: longCaption },
        metadataJson: {},
        scheduledAt: null,
        publishedAt: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const media: PostMedia[] = [
        {
          id: 'med-split-1',
          postId: 'post-split-p1',
          telegramFileId: 'file_id_photo_split',
          telegramFileUniqueId: 'uniq_photo_split',
          mediaType: MediaType.PHOTO,
          fileName: null,
          mimeType: 'image/jpeg',
          fileSize: BigInt(50000),
          caption: null,
          sortOrder: 1,
          createdAt: new Date(),
        },
      ];

      const payload = await renderer.render(post, template, media);

      expect(payload.messages.length).toBe(2);
      expect(payload.messages[0]!.type).toBe('photo');
      expect(payload.messages[0]!.caption).toBeDefined();
      expect(payload.messages[0]!.caption!.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.MAX_CAPTION_LENGTH);
      expect(payload.messages[1]!.type).toBe('text');
      expect(payload.messages[1]!.text!.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH);
    });

    it('1.9 should render post with media group (2 photos) and caption > 1024 into album + text message', async () => {
      const template: PostTemplate = {
        id: 'tpl-album-adv',
        key: 'album_adv',
        name: 'Album Adv',
        description: 'Album',
        schemaJson: {
          fields: [{ key: 'body', label: 'Body', type: 'rich_text', required: true }],
        } as any,
        renderConfig: { layout: '{{body}}' } as any,
        supportedMediaTypes: ['photo'],
        version: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const longCaption = '<i>Album description:</i> ' + 'Comprehensive gallery background text. '.repeat(45);
      const post: Post = {
        id: 'post-album-adv',
        channelId: 'chan-1',
        authorId: 'auth-1',
        templateId: 'tpl-album-adv',
        templateVersion: 1,
        status: PostStatus.APPROVED,
        version: 1,
        contentJson: { body: longCaption },
        metadataJson: {},
        scheduledAt: null,
        publishedAt: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mediaGroup: PostMedia[] = [
        {
          id: 'mg-1',
          postId: 'post-album-adv',
          telegramFileId: 'album_file_1',
          telegramFileUniqueId: 'u1',
          mediaType: MediaType.PHOTO,
          fileName: null,
          mimeType: 'image/jpeg',
          fileSize: null,
          caption: null,
          sortOrder: 1,
          createdAt: new Date(),
        },
        {
          id: 'mg-2',
          postId: 'post-album-adv',
          telegramFileId: 'album_file_2',
          telegramFileUniqueId: 'u2',
          mediaType: MediaType.PHOTO,
          fileName: null,
          mimeType: 'image/jpeg',
          fileSize: null,
          caption: null,
          sortOrder: 2,
          createdAt: new Date(),
        },
      ];

      const payload = await renderer.render(post, template, mediaGroup);

      expect(payload.messages.length).toBe(2);
      expect(payload.messages[0]!.type).toBe('media_group');
      expect(payload.messages[0]!.items).toHaveLength(2);
      expect(payload.messages[0]!.items![0]?.caption).toBeDefined();
      expect(payload.messages[0]!.items![0]!.caption!.length).toBeLessThanOrEqual(1024);
      expect(payload.messages[0]!.items![1]?.caption).toBeUndefined(); // Only 1st item carries caption
      expect(payload.messages[1]!.type).toBe('text');
      expect(payload.messages[1]!.text!.length).toBeLessThanOrEqual(4096);
    });
  });

  // =========================================================================
  // Track 2: Media Album Batching, Burst Concurrency & Limit Enforcement
  // =========================================================================
  describe('Track 2: Media Album Batching, Burst Concurrency & Limit Enforcement', () => {
    let mediaService: MediaService;
    let postWizardService: PostWizardService;
    let mockPrisma: any;
    let mockPostsRepo: any;
    let mockAuditService: any;
    let mockPermService: any;
    let mockRedisClient: any;
    let mockRedisService: any;

    const basePost: Post = {
      id: 'post-media-burst',
      channelId: 'chan-1',
      templateId: 'tpl-1',
      templateVersion: 1,
      authorId: 'actor-author-1',
      status: PostStatus.DRAFT,
      version: 1,
      contentJson: {},
      metadataJson: {},
      scheduledAt: null,
      publishedAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      jest.useFakeTimers();

      const mediaItemsInDb: PostMedia[] = [];

      mockPrisma = {
        postMedia: {
          count: jest.fn().mockImplementation(async ({ where }: { where: { postId: string } }) => {
            return mediaItemsInDb.filter((m) => m.postId === where.postId).length;
          }),
          findFirst: jest.fn().mockImplementation(async () => {
            if (mediaItemsInDb.length === 0) return null;
            return mediaItemsInDb[mediaItemsInDb.length - 1];
          }),
          findMany: jest.fn().mockImplementation(async () => [...mediaItemsInDb]),
          findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
            return mediaItemsInDb.find((m) => m.id === where.id) ?? null;
          }),
          create: jest.fn().mockImplementation(async ({ data }: { data: any }) => {
            const created = { id: `pm-${Date.now()}-${Math.random()}`, ...data, createdAt: new Date() };
            mediaItemsInDb.push(created);
            return created;
          }),
          delete: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
            const idx = mediaItemsInDb.findIndex((m) => m.id === where.id);
            if (idx !== -1) mediaItemsInDb.splice(idx, 1);
            return {};
          }),
          update: jest.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: any }) => {
            const item = mediaItemsInDb.find((m) => m.id === where.id);
            if (item) Object.assign(item, data);
            return item;
          }),
        },
        $transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockPrisma)),
      };

      let currentVersion = 1;
      mockPostsRepo = {
        findById: jest.fn().mockImplementation(async (id: string) => ({
          ...basePost,
          id,
          version: currentVersion,
        })),
        updateWithOcc: jest.fn().mockImplementation(async (id: string, expectedVersion: number) => {
          if (expectedVersion !== currentVersion) {
            throw new PostConflictException(id, expectedVersion, currentVersion);
          }
          currentVersion += 1;
          return { ...basePost, version: currentVersion };
        }),
      };

      mockAuditService = {
        record: jest.fn().mockResolvedValue(undefined),
      };

      mockPermService = {
        enforcePostEditPermission: jest.fn().mockResolvedValue(undefined),
      };

      mediaService = new MediaService(mockPrisma, mockPostsRepo, mockAuditService, mockPermService);

      const redisStore = new Map<string, string[]>();
      mockRedisClient = {
        rpush: jest.fn().mockImplementation(async (key: string, val: string) => {
          if (!redisStore.has(key)) redisStore.set(key, []);
          redisStore.get(key)!.push(val);
          return redisStore.get(key)!.length;
        }),
        lrange: jest.fn().mockImplementation(async (key: string, start: number, stop: number) => {
          const arr = redisStore.get(key) || [];
          if (stop === -1) return arr.slice(start);
          return arr.slice(start, stop + 1);
        }),
        del: jest.fn().mockImplementation(async (key: string) => {
          redisStore.delete(key);
          return 1;
        }),
        expire: jest.fn().mockResolvedValue(1),
      };

      const stringStore = new Map<string, string>();
      mockRedisService = {
        getClient: () => mockRedisClient,
        get: jest.fn().mockImplementation(async (key: string) => stringStore.get(key) ?? null),
        set: jest.fn().mockImplementation(async (key: string, val: string) => stringStore.set(key, val)),
        del: jest.fn().mockImplementation(async (key: string) => stringStore.delete(key)),
      };

      postWizardService = new PostWizardService(
        {} as any,
        mockPostsRepo,
        {} as any,
        {} as any,
        {} as any,
        mediaService,
        mockRedisService,
        new HtmlSanitizer(),
      );
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('2.1 should debounce a rapid burst of 10 incoming album items into a single attachMediaBatch call with 1 OCC increment', async () => {
      const actorId = 'actor-author-1';
      const mediaGroupId = 'album-burst-group-10';

      // Seed wizard session
      await mockRedisService.set(
        `wizard:session:${actorId}`,
        JSON.stringify({ postId: basePost.id, channelId: 'chan-1', step: 'MEDIA_UPLOAD', expectedVersion: 1 }),
      );

      const batchCompleteCallback = jest.fn();

      // Simulate 10 incoming media messages sent concurrently by Telegram within 50ms
      const promises: Promise<any>[] = [];
      for (let i = 0; i < 10; i++) {
        const dto: AttachMediaDto = {
          telegramFileId: `file_album_${i}`,
          telegramFileUniqueId: `uniq_${i}`,
          mediaType: MediaType.PHOTO,
          sortOrder: i + 1,
        };
        promises.push(
          postWizardService.processMediaUpload(actorId, dto, mediaGroupId, batchCompleteCallback),
        );
      }

      const uploadResults = await Promise.all(promises);
      for (const res of uploadResults) {
        expect(res.isBatch).toBe(true);
        expect(res.success).toBe(true);
      }

      // At this instant, debounce timer is still pending (600ms not yet elapsed)
      expect(mockPostsRepo.updateWithOcc).not.toHaveBeenCalled();
      expect(batchCompleteCallback).not.toHaveBeenCalled();

      // Advance timers to trigger debounce callback
      await jest.advanceTimersByTimeAsync(650);

      // Invariant 1: Exactly ONE batch update executed
      expect(mockPostsRepo.updateWithOcc).toHaveBeenCalledTimes(1);
      // Invariant 2: Version incremented from 1 to 2
      const freshPost = await mockPostsRepo.findById(basePost.id);
      expect(freshPost.version).toBe(2);
      // Invariant 3: Audit log contains count 10
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.MEDIA_ADDED,
          payload: expect.objectContaining({ count: 10, version: 2 }),
        }),
        expect.anything(),
      );
      // Invariant 4: batchCompleteCallback called with count 10
      expect(batchCompleteCallback).toHaveBeenCalledWith(10);
    });

    it('2.2 should reject album batch if attaching items would exceed maximum media group size (10)', async () => {
      const actorId = 'actor-author-1';

      // 11 items in batch
      const elevenItems: AttachMediaDto[] = Array.from({ length: 11 }, (_, i) => ({
        telegramFileId: `file_${i}`,
        telegramFileUniqueId: `uniq_${i}`,
        mediaType: MediaType.PHOTO,
      }));

      await expect(
        mediaService.attachMediaBatch(basePost.id, 1, actorId, elevenItems),
      ).rejects.toThrow(ValidationException);

      await expect(
        mediaService.attachMediaBatch(basePost.id, 1, actorId, elevenItems),
      ).rejects.toThrow(/Максимальный лимит медиагруппы — 10/);
    });

    it('2.3 should reject batch when existing media count + new items > 10', async () => {
      const actorId = 'actor-author-1';

      // Pre-attach 8 items
      const existingItems: AttachMediaDto[] = Array.from({ length: 8 }, (_, i) => ({
        telegramFileId: `file_pre_${i}`,
        telegramFileUniqueId: `uniq_pre_${i}`,
        mediaType: MediaType.PHOTO,
      }));
      await mediaService.attachMediaBatch(basePost.id, 1, actorId, existingItems);

      // Now post has 8 items. Version is 2. Attempting to attach 3 more (8+3=11) must fail!
      const newItems: AttachMediaDto[] = [
        { telegramFileId: 'f9', telegramFileUniqueId: 'u9', mediaType: MediaType.PHOTO },
        { telegramFileId: 'f10', telegramFileUniqueId: 'u10', mediaType: MediaType.PHOTO },
        { telegramFileId: 'f11', telegramFileUniqueId: 'u11', mediaType: MediaType.PHOTO },
      ];

      await expect(
        mediaService.attachMediaBatch(basePost.id, 2, actorId, newItems),
      ).rejects.toThrow(ValidationException);
    });

    it('2.4 should reject single media upload when post already has 10 items attached', async () => {
      const actorId = 'actor-author-1';
      const tenItems: AttachMediaDto[] = Array.from({ length: 10 }, (_, i) => ({
        telegramFileId: `file_ten_${i}`,
        telegramFileUniqueId: `uniq_ten_${i}`,
        mediaType: MediaType.PHOTO,
      }));
      await mediaService.attachMediaBatch(basePost.id, 1, actorId, tenItems);

      // 11th item must be rejected
      const extraItem: AttachMediaDto = {
        telegramFileId: 'file_extra',
        telegramFileUniqueId: 'uniq_extra',
        mediaType: MediaType.PHOTO,
      };

      await expect(
        mediaService.attachMedia(basePost.id, 2, actorId, extraItem),
      ).rejects.toThrow(ValidationException);
    });

    it('2.5 should detect document as video when mimeType is video/* or extension is .mp4', () => {
      const docVideo1 = {
        mediaType: MediaType.DOCUMENT,
        mimeType: 'video/mp4',
        fileName: 'clip.dat',
      } as PostMedia;

      const docVideo2 = {
        mediaType: MediaType.DOCUMENT,
        mimeType: 'application/octet-stream',
        fileName: 'presentation.mp4',
      } as PostMedia;

      const docPdf = {
        mediaType: MediaType.DOCUMENT,
        mimeType: 'application/pdf',
        fileName: 'report.pdf',
      } as PostMedia;

      expect(isDocumentAsVideo(docVideo1)).toBe(true);
      expect(isDocumentAsVideo(docVideo2)).toBe(true);
      expect(isDocumentAsVideo(docPdf)).toBe(false);
    });

    it('2.6 should disallow mixing documents with photos/videos in a media group', () => {
      const mixedGroup = [
        { mediaType: MediaType.PHOTO } as PostMedia,
        { mediaType: MediaType.DOCUMENT } as PostMedia,
      ];

      const res = validateMediaGroupCompatibility(mixedGroup);
      expect(res.isValid).toBe(false);
      expect(res.error).toContain('Нельзя объединять фото/видео и документы');
    });

    it('2.7 should renormalize remaining sort orders to gapless 1..N upon media deletion', async () => {
      const actorId = 'actor-author-1';
      // Attach 4 items (sortOrder 1, 2, 3, 4)
      const fourItems: AttachMediaDto[] = Array.from({ length: 4 }, (_, i) => ({
        telegramFileId: `f_${i}`,
        telegramFileUniqueId: `u_${i}`,
        mediaType: MediaType.PHOTO,
        sortOrder: i + 1,
      }));
      await mediaService.attachMediaBatch(basePost.id, 1, actorId, fourItems);

      const itemsInDb = await mockPrisma.postMedia.findMany();
      expect(itemsInDb).toHaveLength(4);

      // Remove item #2 (index 1)
      const itemToDelete = itemsInDb[1]!;
      await mediaService.removeMedia(basePost.id, itemToDelete.id, 2, actorId);

      // Check remaining 3 items have sortOrder 1, 2, 3 without gap
      const remaining = await mockPrisma.postMedia.findMany();
      expect(remaining).toHaveLength(3);
      expect(remaining.map((m: any) => m.sortOrder)).toEqual([1, 2, 3]);
    });
  });

  // =========================================================================
  // Track 3: Wizard Recovery from Partial Entries & Session Interruptions
  // =========================================================================
  describe('Track 3: Wizard Recovery from Partial Entries & Session Interruptions', () => {
    let wizardService: PostWizardService;
    let draftManagerService: DraftManagerService;
    let validator: TemplateValidator;
    let mockPostsService: any;
    let mockPostsRepo: any;
    let mockTemplatesService: any;
    let mockChannelsService: any;
    let mockRedisService: any;

    const multiFieldTemplate: PostTemplate = {
      id: 'tpl-multi-field',
      key: 'feature_article',
      name: 'Большая статья',
      description: 'Статья с обязательными и опциональными полями',
      schemaJson: {
        fields: [
          { key: 'title', label: 'Заголовок', type: 'text', required: true, maxLength: 150 },
          { key: 'subtitle', label: 'Подзаголовок', type: 'text', required: false, maxLength: 150 },
          { key: 'lead', label: 'Вводка', type: 'text', required: false, maxLength: 300 },
          { key: 'body', label: 'Основной текст', type: 'rich_text', required: true, maxLength: 4000 },
          { key: 'cta', label: 'Призыв к действию', type: 'text', required: false, maxLength: 100 },
        ],
      } as any,
      renderConfig: { layout: '<b>{{title}}</b>\n\n{{subtitle}}\n\n{{body}}\n\n{{cta}}' } as any,
      supportedMediaTypes: ['photo'],
      version: 1,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let postRecord: Post;

    beforeEach(() => {
      postRecord = {
        id: 'post-recovery-uuid',
        channelId: 'chan-1',
        templateId: multiFieldTemplate.id,
        templateVersion: 1,
        authorId: 'author-101',
        status: PostStatus.DRAFT,
        version: 1,
        contentJson: {},
        metadataJson: {},
        scheduledAt: null,
        publishedAt: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      validator = new TemplateValidator();

      const memoryStore = new Map<string, string>();
      mockRedisService = {
        get: jest.fn().mockImplementation(async (k: string) => memoryStore.get(k) ?? null),
        set: jest.fn().mockImplementation(async (k: string, v: string) => {
          memoryStore.set(k, v);
          return 'OK';
        }),
        del: jest.fn().mockImplementation(async (k: string) => {
          memoryStore.delete(k);
          return 1;
        }),
      };

      mockPostsService = {
        createDraft: jest.fn().mockResolvedValue(postRecord),
        autosaveStep: jest.fn().mockImplementation(async (
          postId: string,
          expectedVersion: number,
          _actorId: string,
          fieldKey: string,
          val: unknown,
        ) => {
          if (expectedVersion !== postRecord.version) {
            throw new PostConflictException(postId, expectedVersion, postRecord.version);
          }
          postRecord.version += 1;
          const currentContent = (postRecord.contentJson as Record<string, unknown>) || {};
          postRecord.contentJson = { ...currentContent, [fieldKey]: val } as any;
          return { ...postRecord };
        }),
        softDeletePost: jest.fn(),
      };

      mockPostsRepo = {
        findById: jest.fn().mockImplementation(async () => ({ ...postRecord })),
        findByAuthor: jest.fn().mockResolvedValue([]),
      };

      mockTemplatesService = {
        getById: jest.fn().mockResolvedValue(multiFieldTemplate),
        getActiveTemplates: jest.fn().mockResolvedValue([multiFieldTemplate]),
      };

      mockChannelsService = {
        autoSkipSingleChannel: jest.fn().mockResolvedValue({
          singleChannel: { id: 'chan-1', title: 'Main' },
          channels: [{ id: 'chan-1', title: 'Main' }],
          mustChoose: false,
        }),
      };

      wizardService = new PostWizardService(
        mockPostsService,
        mockPostsRepo,
        mockTemplatesService,
        validator,
        mockChannelsService,
        {} as any,
        mockRedisService,
        new HtmlSanitizer(),
      );

      draftManagerService = new DraftManagerService(
        mockPostsService,
        mockPostsRepo,
        mockTemplatesService,
        validator,
        mockRedisService,
        new HtmlSanitizer(),
      );
    });

    it('3.1 should allow skipping multiple intermediate optional fields and persist null values under OCC', async () => {
      const actorId = 'author-101';
      // Step 2: Select template -> draft initialized at fieldIndex 0 (title)
      await wizardService.selectTemplate(actorId, multiFieldTemplate.id);

      // Step 3.1: Enter title (required)
      const resTitle = await wizardService.processFieldInput(actorId, 'Главный заголовок');
      expect(resTitle.type).toBe('FIELD_PROMPT');
      expect(resTitle.field?.key).toBe('subtitle'); // Next is subtitle (optional)

      // Step 3.2: Skip subtitle (optional)
      const resSkipSub = await wizardService.skipField(actorId, 'subtitle');
      expect(resSkipSub.type).toBe('FIELD_PROMPT');
      expect(resSkipSub.field?.key).toBe('lead'); // Next is lead (optional)
      expect((postRecord.contentJson as any).subtitle).toBeNull();

      // Step 3.3: Skip lead (optional)
      const resSkipLead = await wizardService.skipField(actorId, 'lead');
      expect(resSkipLead.type).toBe('FIELD_PROMPT');
      expect(resSkipLead.field?.key).toBe('body'); // Next is body (required)
      expect((postRecord.contentJson as any).lead).toBeNull();

      // Step 3.4: Enter body (required)
      const resBody = await wizardService.processFieldInput(actorId, 'Подробный текст публикации.');
      expect(resBody.type).toBe('FIELD_PROMPT');
      expect(resBody.field?.key).toBe('cta'); // Next is cta (optional)

      // Step 3.5: Skip cta (optional)
      const resSkipCta = await wizardService.skipField(actorId, 'cta');
      // All fields done -> advances to MEDIA_PROMPT
      expect(resSkipCta.type).toBe('MEDIA_PROMPT');
      expect((postRecord.contentJson as any).cta).toBeNull();
    });

    it('3.2 should strictly reject skipping a required field and maintain session position', async () => {
      const actorId = 'author-101';
      await wizardService.selectTemplate(actorId, multiFieldTemplate.id);

      // Attempt to skip 'title' (required)
      const res = await wizardService.skipField(actorId, 'title');

      expect(res.type).toBe('FIELD_PROMPT');
      expect(res.text).toContain('обязательно для заполнения и не может быть пропущено');
      expect(res.field?.key).toBe('title');
      // Post version must NOT have been incremented
      expect(postRecord.version).toBe(1);
    });

    it('3.3 should reject field input exceeding maxLength without mutating DB or advancing field', async () => {
      const actorId = 'author-101';
      await wizardService.selectTemplate(actorId, multiFieldTemplate.id);

      // Title maxLength is 150 chars. Send 180 chars.
      const longTitle = 'OverlyLongTitle '.repeat(15);
      const res = await wizardService.processFieldInput(actorId, longTitle);

      expect(res.type).toBe('FIELD_PROMPT');
      expect(res.text).toContain('Ошибка проверки');
      expect(res.text).toContain('150');
      expect(postRecord.version).toBe(1);
      expect((postRecord.contentJson as any).title).toBeUndefined();
    });

    it('3.4 should recover draft from PostgreSQL after complete Redis loss and resume at first missing required field', async () => {
      const actorId = 'author-101';
      // Prepare post in PostgreSQL: title entered, optional subtitle & lead omitted, body missing
      postRecord.contentJson = {
        title: 'Уже сохраненный заголовок',
        subtitle: null,
      };
      postRecord.version = 3;

      // Simulate total Redis session loss
      await mockRedisService.del(`wizard:session:${actorId}`);

      // User resumes draft
      const resumeRes = await draftManagerService.resumeDraft(actorId, postRecord.id);

      expect(resumeRes.action).toBe('FIELD_PROMPT');
      // Must identify 'body' (the first missing REQUIRED field), bypassing unfilled optional 'lead'
      expect(resumeRes.field?.key).toBe('body');
      expect(resumeRes.text).toContain('Основной текст');

      // Redis session was re-established with correct fieldIndex for 'body' (index 3)
      const sessionRaw = await mockRedisService.get(`wizard:session:${actorId}`);
      expect(sessionRaw).not.toBeNull();
      const session = JSON.parse(sessionRaw!);
      expect(session.fieldIndex).toBe(3);
      expect(session.expectedVersion).toBe(3);
    });

    it('3.5 should return CONTROL_CARD if all required fields are present even if optional fields are omitted', async () => {
      const actorId = 'author-101';
      postRecord.contentJson = {
        title: 'Заголовок',
        body: 'Основной текст статьи',
        // subtitle, lead, cta omitted
      };

      const resumeRes = await draftManagerService.resumeDraft(actorId, postRecord.id);

      expect(resumeRes.action).toBe('CONTROL_CARD');
      expect(resumeRes.text).toContain('Черновик готов к просмотру');
    });

    it('3.6.1 should verify that PostsService.autosaveStep strictly rejects stale expectedVersion with PostConflictException', async () => {
      const actorId = 'author-101';
      postRecord.version = 6;

      // When called with stale expectedVersion 5 while postRecord.version is 6
      await expect(
        mockPostsService.autosaveStep(postRecord.id, 5, actorId, 'title', 'Новый заголовок'),
      ).rejects.toThrow(PostConflictException);
    });

    it('3.6.2 should strictly pass session.expectedVersion to autosaveStep and reject with PostConflictException on concurrent edit', async () => {
      const actorId = 'author-101';
      postRecord.contentJson = { title: 'Старый заголовок', body: 'Текст' };
      postRecord.version = 5;

      // Author starts editing 'title' (session captures expectedVersion: 5)
      await draftManagerService.startEditField(actorId, postRecord.id, 'title');

      const rawSession = await mockRedisService.get(`wizard:session:${actorId}`);
      const session = JSON.parse(rawSession!);
      expect(session.expectedVersion).toBe(5);

      // Concurrent modification occurs in DB: post is now version 6
      postRecord.version = 6;

      // submitEditedField executes: it passes session.expectedVersion (5) to autosaveStep,
      // which rejects with PostConflictException because DB version is 6
      await expect(
        draftManagerService.submitEditedField(actorId, 'Новый заголовок'),
      ).rejects.toThrow(PostConflictException);

      expect(mockPostsService.autosaveStep).toHaveBeenCalledWith(
        postRecord.id,
        5, // Correctly passed session.expectedVersion (5) instead of post.version (6)!
        actorId,
        'title',
        'Новый заголовок',
      );
    });
  });

  // =========================================================================
  // Track 4: Europe/Kyiv Timezone Conversion & Past-Date Validation
  // =========================================================================
  describe('Track 4: Europe/Kyiv Timezone Conversion & Past-Date Validation', () => {
    it('4.1 should correctly convert Europe/Kyiv Summer Time (EEST, UTC+3) to UTC instant', () => {
      // July is in EEST (UTC+3)
      // 20.07.2026 15:00 Kyiv time -> 12:00:00 UTC
      const kyivSummerInput = '20.07.2026 15:00';
      const parsedUtc = parseAndValidateScheduledDate(kyivSummerInput, 'Europe/Kyiv', 0);

      expect(parsedUtc.toISOString()).toBe('2026-07-20T12:00:00.000Z');
      expect(parsedUtc.getUTCHours()).toBe(12);

      // Round-trip formatting back to Kyiv time
      const formatted = formatChannelDate(parsedUtc, 'Europe/Kyiv');
      expect(formatted).toBe('20.07.2026 15:00');
    });

    it('4.2 should correctly convert Europe/Kyiv Winter Time (EET, UTC+2) to UTC instant', () => {
      // January is in EET (UTC+2)
      // 20.01.2026 15:00 Kyiv time -> 13:00:00 UTC
      const kyivWinterInput = '20.01.2026 15:00';
      const parsedUtc = parseAndValidateScheduledDate(kyivWinterInput, 'Europe/Kyiv', 0);

      expect(parsedUtc.toISOString()).toBe('2026-01-20T13:00:00.000Z');
      expect(parsedUtc.getUTCHours()).toBe(13);

      const formatted = formatChannelDate(parsedUtc, 'Europe/Kyiv');
      expect(formatted).toBe('20.01.2026 15:00');
    });

    it('4.3 should accurately handle 2026 Spring Forward DST transition (last Sunday of March)', () => {
      // In 2026, Kyiv springs forward on March 29 (UTC+2 -> UTC+3)
      // Before transition: March 28, 12:00 Kyiv is UTC+2 -> 10:00 UTC
      const beforeDst = parseAndValidateScheduledDate('28.03.2026 12:00', 'Europe/Kyiv', 0);
      expect(beforeDst.toISOString()).toBe('2026-03-28T10:00:00.000Z');

      // After transition: March 30, 12:00 Kyiv is UTC+3 -> 09:00 UTC
      const afterDst = parseAndValidateScheduledDate('30.03.2026 12:00', 'Europe/Kyiv', 0);
      expect(afterDst.toISOString()).toBe('2026-03-30T09:00:00.000Z');
    });

    it('4.4 should accurately handle 2026 Fall Back DST transition (last Sunday of October)', () => {
      // In 2026, Kyiv falls back on October 25 (UTC+3 -> UTC+2)
      // Before transition: October 24, 12:00 Kyiv is UTC+3 -> 09:00 UTC
      const beforeFallBack = parseAndValidateScheduledDate('24.10.2026 12:00', 'Europe/Kyiv', 0);
      expect(beforeFallBack.toISOString()).toBe('2026-10-24T09:00:00.000Z');

      // After transition: October 26, 12:00 Kyiv is UTC+2 -> 10:00 UTC
      const afterFallBack = parseAndValidateScheduledDate('26.10.2026 12:00', 'Europe/Kyiv', 0);
      expect(afterFallBack.toISOString()).toBe('2026-10-26T10:00:00.000Z');
    });

    it('4.5 should reject dates in the past with exact boundary test against reference nowMs', () => {
      // Reference: 22.09.2026 10:00:00 UTC (13:00 Kyiv)
      const nowMs = Date.UTC(2026, 8, 22, 10, 0, 0);

      // 1 minute in the past: 12:59 Kyiv
      expect(() => {
        parseAndValidateScheduledDate('22.09.2026 12:59', 'Europe/Kyiv', nowMs);
      }).toThrow(ValidationException);
      expect(() => {
        parseAndValidateScheduledDate('22.09.2026 12:59', 'Europe/Kyiv', nowMs);
      }).toThrow(/Нельзя планировать публикацию в прошлом/);

      // Exact millisecond boundary: 13:00:00 Kyiv
      expect(() => {
        parseAndValidateScheduledDate('22.09.2026 13:00', 'Europe/Kyiv', nowMs);
      }).toThrow(/Нельзя планировать публикацию в прошлом/);

      // 1 minute in the future: 13:01 Kyiv -> MUST SUCCEED
      const futureDate = parseAndValidateScheduledDate('22.09.2026 13:01', 'Europe/Kyiv', nowMs);
      expect(futureDate.getTime()).toBeGreaterThan(nowMs);
    });

    it('4.6 should reject invalid calendar dates and malformed strings', () => {
      const nowMs = 0;
      // February 31 does not exist
      expect(() => parseAndValidateScheduledDate('31.02.2026 12:00', 'Europe/Kyiv', nowMs)).toThrow(ValidationException);
      // April 31 does not exist (April has 30 days)
      expect(() => parseAndValidateScheduledDate('31.04.2026 12:00', 'Europe/Kyiv', nowMs)).toThrow(ValidationException);
      // Feb 29 in non-leap year 2025
      expect(() => parseAndValidateScheduledDate('29.02.2025 12:00', 'Europe/Kyiv', nowMs)).toThrow(ValidationException);
      // Malformed inputs
      expect(() => parseAndValidateScheduledDate('not-a-valid-date', 'Europe/Kyiv', nowMs)).toThrow(ValidationException);
      expect(() => parseAndValidateScheduledDate('99.99.9999 99:99', 'Europe/Kyiv', nowMs)).toThrow(ValidationException);
    });

    it('4.7 should safely fall back to DEFAULT_CHANNEL_TIMEZONE (Europe/Kyiv) if invalid timezone string is provided', () => {
      const parsed = parseAndValidateScheduledDate('20.07.2026 15:00', 'Invalid/NonExistent_Zone', 0);
      expect(parsed.toISOString()).toBe('2026-07-20T12:00:00.000Z');
    });

    it('4.8 should support yyyy-MM-dd and ISO datetime format inputs in channel timezone', () => {
      const parsedIso = parseAndValidateScheduledDate('2026-07-20 15:00', 'Europe/Kyiv', 0);
      expect(parsedIso.toISOString()).toBe('2026-07-20T12:00:00.000Z');

      const parsedStandardIso = parseAndValidateScheduledDate('2026-07-20T15:00:00', 'Europe/Kyiv', 0);
      expect(parsedStandardIso.toISOString()).toBe('2026-07-20T12:00:00.000Z');
    });

    describe('SchedulingService Domain Orchestration Stress', () => {
      let schedulingService: SchedulingService;
      let mockPrisma: any;
      let mockPostWorkflow: any;
      let mockPreflight: any;
      let mockPermService: any;
      let mockQueue: any;

      const channel: Channel = {
        id: 'chan-kyiv-1',
        telegramChatId: '-1001234567890',
        title: 'Kyiv Channel',
        username: 'kyiv_news',
        timezone: 'Europe/Kyiv',
        publicationMode: 'IMMEDIATE',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const approvedPost: any = {
        id: 'post-sched-1',
        channelId: channel.id,
        channel,
        authorId: 'auth-1',
        templateId: 'tpl-1',
        templateVersion: 1,
        status: PostStatus.APPROVED,
        version: 4,
        contentJson: { title: 'Approved Title' },
        metadataJson: {},
        scheduledAt: null,
        publishedAt: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      beforeEach(() => {
        mockPrisma = {
          post: {
            findUnique: jest.fn().mockResolvedValue({ ...approvedPost }),
          },
          publicationJob: {
            create: jest.fn().mockImplementation(async ({ data }: { data: any }) => ({
              id: 'pub-job-uuid-1',
              ...data,
              createdAt: new Date(),
            })),
            findFirst: jest.fn().mockResolvedValue({
              id: 'pub-job-uuid-1',
              postId: approvedPost.id,
              status: PublicationJobStatus.PENDING,
            }),
            update: jest.fn().mockResolvedValue({}),
          },
        };

        mockPostWorkflow = {
          transition: jest.fn().mockImplementation(async (cmd: any) => ({
            ...approvedPost,
            status: cmd.targetStatus,
            version: approvedPost.version + 1,
            scheduledAt: cmd.scheduledAt,
          })),
        };

        mockPreflight = {
          validateStage1: jest.fn().mockResolvedValue({ isValid: true, errors: [] }),
        };

        mockPermService = {
          checkChannelPermission: jest.fn().mockResolvedValue(true),
        };

        mockQueue = {
          add: jest.fn().mockResolvedValue({ id: 'bull-job-1' }),
          getJob: jest.fn().mockResolvedValue({ remove: jest.fn().mockResolvedValue(true) }),
        };

        schedulingService = new SchedulingService(
          mockPrisma,
          mockPostWorkflow,
          mockPreflight,
          mockPermService,
          mockQueue as unknown as Queue,
        );
      });

      it('4.9 should schedule post: parse Kyiv time, validate Stage 1, transition APPROVED -> SCHEDULED, create PublicationJob, and enqueue delayed BullMQ job', async () => {
        const actorId = 'editor-user-1';
        // Input: future date in Kyiv timezone
        const futureDateString = '20.07.2029 18:30';

        const result = await schedulingService.schedulePost(approvedPost.id, futureDateString, actorId, 4);

        expect(result.status).toBe(PostStatus.SCHEDULED);
        expect(result.version).toBe(5);

        // Stage 1 preflight must have been called
        expect(mockPreflight.validateStage1).toHaveBeenCalledWith(approvedPost.id, actorId);

        // State machine transition
        expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
          expect.objectContaining({
            postId: approvedPost.id,
            targetStatus: PostStatus.SCHEDULED,
            action: PostAction.SCHEDULE,
            actorId,
            expectedVersion: 4,
          }),
        );

        // PublicationJob in PostgreSQL with idempotency key
        expect(mockPrisma.publicationJob.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            postId: approvedPost.id,
            postVersion: 5,
            idempotencyKey: `publish:${approvedPost.id}:5`,
            status: PublicationJobStatus.PENDING,
          }),
        });

        // Delayed BullMQ job enqueued
        expect(mockQueue.add).toHaveBeenCalledWith(
          JOB_NAMES.PUBLISH_POST,
          expect.objectContaining({
            postId: approvedPost.id,
            postVersion: 5,
            isScheduled: true,
          }),
          expect.objectContaining({
            jobId: 'pub-job-uuid-1',
            attempts: 3,
            backoff: expect.objectContaining({ type: 'exponential', delay: 2000 }),
          }),
        );
      });

      it('4.10 should reject scheduling for posts not in APPROVED status (e.g. DRAFT or PENDING_REVIEW)', async () => {
        const actorId = 'editor-user-1';
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...approvedPost,
          status: PostStatus.DRAFT,
        });

        await expect(
          schedulingService.schedulePost(approvedPost.id, '20.07.2029 18:30', actorId),
        ).rejects.toThrow(InvalidPostStateTransitionException);
      });

      it('4.11 should cancel schedule: verify permission, remove delayed BullMQ job, mark DB job CANCELLED, and transition SCHEDULED -> CANCELLED', async () => {
        const actorId = 'editor-user-1';
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...approvedPost,
          status: PostStatus.SCHEDULED,
          version: 5,
        });

        const cancelled = await schedulingService.cancelSchedule(approvedPost.id, actorId, 5);

        expect(mockPermService.checkChannelPermission).toHaveBeenCalledWith(
          actorId,
          channel.id,
          ChannelPermission.CANCEL_SCHEDULE,
        );

        expect(mockQueue.getJob).toHaveBeenCalledWith('pub-job-uuid-1');
        expect(mockPrisma.publicationJob.update).toHaveBeenCalledWith({
          where: { id: 'pub-job-uuid-1' },
          data: { status: PublicationJobStatus.CANCELLED },
        });

        expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
          expect.objectContaining({
            postId: approvedPost.id,
            targetStatus: PostStatus.CANCELLED,
            action: PostAction.CANCEL,
            actorId,
            expectedVersion: 5,
          }),
        );

        expect(cancelled.status).toBe(PostStatus.CANCELLED);
      });

      it('4.12 should reject cancel schedule if user lacks CANCEL_SCHEDULE channel permission', async () => {
        const actorId = 'author-unauthorized';
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...approvedPost,
          status: PostStatus.SCHEDULED,
        });
        mockPermService.checkChannelPermission.mockResolvedValueOnce(false);

        await expect(
          schedulingService.cancelSchedule(approvedPost.id, actorId),
        ).rejects.toThrow(PermissionDeniedException);
      });
    });
  });
});
