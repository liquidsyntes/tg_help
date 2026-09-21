import 'reflect-metadata';
import { HtmlSanitizer } from '../../src/modules/rendering/html-sanitizer.service';
import { HtmlSplitter } from '../../src/modules/rendering/html-splitter';
import { TelegramRenderer } from '../../src/modules/rendering/telegram-renderer.service';
import { Post, PostTemplate, PostMedia, MediaType, PostStatus } from '@prisma/client';
import { TELEGRAM_LIMITS } from '../../src/common/constants/telegram-limits';

describe('Rendering Module Unit Tests', () => {
  let sanitizer: HtmlSanitizer;
  let renderer: TelegramRenderer;

  beforeEach(() => {
    sanitizer = new HtmlSanitizer();
    renderer = new TelegramRenderer(sanitizer);
  });

  describe('HtmlSanitizer', () => {
    it('should preserve allowed Telegram HTML tags', () => {
      const input =
        '<b>Bold</b> <i>Italic</i> <u>Underline</u> <s>Strike</s> <code>code</code> <pre>pre</pre> <blockquote>quote</blockquote> <a href="https://example.com">link</a>';
      const output = sanitizer.sanitize(input);
      expect(output).toBe(input);
    });

    it('should normalize tag aliases to Telegram canonical tags', () => {
      const input =
        '<strong>Bold</strong> <em>Italic</em> <ins>Underline</ins> <strike>Strike1</strike> <del>Strike2</del>';
      const expected = '<b>Bold</b> <i>Italic</i> <u>Underline</u> <s>Strike1</s> <s>Strike2</s>';
      expect(sanitizer.sanitize(input)).toBe(expected);
    });

    it('should strip dangerous tags completely along with their inner content', () => {
      const input =
        'Normal <script>alert("xss")</script> <style>body{color:red}</style> <iframe src="evil.com"></iframe> Text';
      const output = sanitizer.sanitize(input);
      expect(output).not.toContain('<script');
      expect(output).not.toContain('alert');
      expect(output).not.toContain('<style');
      expect(output).not.toContain('body{color:red}');
      expect(output).not.toContain('<iframe');
      expect(output.replace(/\s+/g, ' ')).toBe('Normal Text');
    });

    it('should strip inline event handlers and disallowed attributes', () => {
      const input =
        '<b onclick="alert(1)" id="my-bold" style="color:red">Bold</b> <a href="https://test.com" onclick="steal()">Link</a>';
      expect(sanitizer.sanitize(input)).toBe('<b>Bold</b> <a href="https://test.com">Link</a>');
    });

    it('should filter disallowed protocols on <a> href', () => {
      expect(sanitizer.sanitize('<a href="javascript:alert(1)">Click</a>')).toBe('Click');
      expect(sanitizer.sanitize('<a href="data:text/html,...">Click</a>')).toBe('Click');
      expect(sanitizer.sanitize('<a href="tg://resolve?domain=test">Telegram</a>')).toBe(
        '<a href="tg://resolve?domain=test">Telegram</a>',
      );
      expect(sanitizer.sanitize('<a href="http://example.com">HTTP</a>')).toBe(
        '<a href="http://example.com">HTTP</a>',
      );
    });

    it('should strip layout tags while preserving inner text', () => {
      const input = '<div><p>Paragraph 1</p><span>Span text</span><h1>Heading</h1></div>';
      expect(sanitizer.sanitize(input)).toBe('Paragraph 1Span textHeading');
    });

    it('should convert <br> and <br/> tags to newlines', () => {
      const input = 'Line 1<br>Line 2<br/>Line 3';
      expect(sanitizer.sanitize(input)).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should balance unclosed and improperly nested tags using LIFO stack', () => {
      expect(sanitizer.sanitize('<b>Unclosed')).toBe('<b>Unclosed</b>');
      expect(sanitizer.sanitize('<b><i>Nested')).toBe('<b><i>Nested</i></b>');
      expect(sanitizer.sanitize('<b><i>Overlap</b></i>')).toBe('<b><i>Overlap</i></b>');
      expect(sanitizer.sanitize('Rogue</b> closing')).toBe('Rogue closing');
    });

    it('should escape raw <, >, and & characters without double-escaping existing entities', () => {
      expect(sanitizer.sanitize('10 < 20 & 30 > 15')).toBe('10 &lt; 20 &amp; 30 &gt; 15');
      expect(sanitizer.sanitize('Tom &amp; Jerry')).toBe('Tom &amp; Jerry');
      expect(sanitizer.sanitize('&lt;hello&gt;')).toBe('&lt;hello&gt;');
    });
  });

  describe('HtmlSplitter', () => {
    it('should return single part if text is within limit', () => {
      const text = 'Short text within limit';
      const result = HtmlSplitter.splitHtml(text, 100);
      expect(result.part1).toBe(text);
      expect(result.part2).toBeUndefined();
    });

    it('should split at natural paragraph breaks (\n\n)', () => {
      const p1 = 'Paragraph 1: ' + 'A'.repeat(50);
      const p2 = 'Paragraph 2: ' + 'B'.repeat(50);
      const combined = `${p1}\n\n${p2}`;

      const { part1, part2 } = HtmlSplitter.splitHtml(combined, 80);
      expect(part1).toBe(p1);
      expect(part2).toBe(p2);
    });

    it('should auto-close active tags in part 1 and reopen them in part 2', () => {
      const text =
        '<b>' + 'Word '.repeat(30) + '</b>'; // ~150 chars inside <b>
      const { part1, part2 } = HtmlSplitter.splitHtml(text, 80);

      expect(part1.startsWith('<b>')).toBe(true);
      expect(part1.endsWith('</b>')).toBe(true);
      expect(part2?.startsWith('<b>')).toBe(true);
      expect(part2?.endsWith('</b>')).toBe(true);
    });

    it('should preserve link attributes when reopening <a> tag across split', () => {
      const text =
        '<a href="https://example.com">' + 'LinkText '.repeat(20) + '</a>';
      const { part1, part2 } = HtmlSplitter.splitHtml(text, 70);

      expect(part1).toContain('<a href="https://example.com">');
      expect(part1.endsWith('</a>')).toBe(true);
      expect(part2).toContain('<a href="https://example.com">');
      expect(part2?.endsWith('</a>')).toBe(true);
    });

    it('should recursively split into chunks all <= maxLength', () => {
      const longHtml = '<p>' + 'Long content line.\n'.repeat(300) + '</p>';
      const chunks = HtmlSplitter.splitIntoChunks(longHtml, 500);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(500);
      }
    });
  });

  describe('TelegramRenderer', () => {
    const mockTemplate: PostTemplate = {
      id: 'tpl-1',
      key: 'longread',
      name: 'Лонг-рид',
      description: 'Статья',
      schemaJson: {
        fields: [
          { key: 'title', label: 'Заголовок', type: 'text', required: true },
          { key: 'lead', label: 'Лид', type: 'text', required: false },
          { key: 'body', label: 'Текст', type: 'rich_text', required: true },
        ],
      },
      renderConfig: {
        layout: '<b>{{title}}</b>\n\n<i>{{lead}}</i>\n\n{{body}}\n\n{{tags}}\n\n{{cta}}',
      },
      supportedMediaTypes: ['photo', 'video', 'media_group'],
      version: 1,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const basePost: Post = {
      id: 'post-1',
      channelId: 'chan-1',
      authorId: 'author-1',
      templateId: 'tpl-1',
      templateVersion: 1,
      status: PostStatus.DRAFT,
      version: 1,
      scheduledAt: null,
      publishedAt: null,
      deletedAt: null,
      metadataJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      contentJson: {
        title: 'Breaking News <Alert>',
        lead: 'Quick lead summary',
        body: '<b>Full details</b> about the update & events.',
        tags: ['news', 'tech'],
        cta: 'Read more: https://tghelp.org',
      },
    };

    it('should interpolate placeholders, escape plain text, and sanitize rich text', () => {
      const rendered = renderer.renderHtml(basePost, mockTemplate);

      expect(rendered).toContain('<b>Breaking News &lt;Alert&gt;</b>');
      expect(rendered).toContain('<i>Quick lead summary</i>');
      expect(rendered).toContain('<b>Full details</b> about the update &amp; events.');
      expect(rendered).toContain('#news #tech');
      expect(rendered).toContain('Read more: https://tghelp.org');
    });

    it('should clean up empty formatting tags when optional fields are omitted', () => {
      const postWithoutLead: Post = {
        ...basePost,
        contentJson: {
          title: 'News Title',
          body: 'Content without lead.',
        },
      };

      const rendered = renderer.renderHtml(postWithoutLead, mockTemplate);
      expect(rendered).not.toContain('<i></i>');
      expect(rendered).not.toContain('\n\n\n');
    });

    it('should render pure text post as single text message if <= 4096 characters', async () => {
      const payload = await renderer.render(basePost, mockTemplate, []);

      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0]?.type).toBe('text');
      expect(payload.messages[0]?.partIndex).toBe(0);
      expect(payload.messages[0]?.text).toBeDefined();
    });

    it('should split text-only post into multiple text messages if > 4096 characters', async () => {
      const hugePost: Post = {
        ...basePost,
        contentJson: {
          title: 'Huge Post',
          body: 'Detailed sentence. '.repeat(400), // ~7600 chars
        },
      };

      const payload = await renderer.render(hugePost, mockTemplate, []);

      expect(payload.messages.length).toBeGreaterThanOrEqual(2);
      payload.messages.forEach((msg, idx) => {
        expect(msg.type).toBe('text');
        expect(msg.partIndex).toBe(idx);
        expect(msg.text?.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH);
      });
    });

    it('should render single media with full caption if text <= 1024 characters', async () => {
      const media: PostMedia[] = [
        {
          id: 'med-1',
          postId: 'post-1',
          telegramFileId: 'photo_file_123',
          telegramFileUniqueId: 'unique_photo_123',
          mediaType: MediaType.PHOTO,
          fileName: null,
          mimeType: 'image/jpeg',
          fileSize: null,
          caption: null,
          sortOrder: 1,
          createdAt: new Date(),
        },
      ];

      const payload = await renderer.render(basePost, mockTemplate, media);

      expect(payload.messages).toHaveLength(1);
      const msg = payload.messages[0];
      expect(msg?.type).toBe('photo');
      expect(msg?.partIndex).toBe(0);
      expect(msg?.fileId).toBe('photo_file_123');
      expect(msg?.caption).toBeDefined();
      expect(msg?.caption?.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.MAX_CAPTION_LENGTH);
    });

    it('should partition single media into Message 1 (media + caption <= 1024) and Message 2 (text <= 4096) when text > 1024', async () => {
      const longPost: Post = {
        ...basePost,
        contentJson: {
          title: 'Article Title',
          lead: 'Article Lead',
          body: 'Extensive paragraph detailing the topic. '.repeat(60), // ~2500 chars
        },
      };

      const media: PostMedia[] = [
        {
          id: 'med-1',
          postId: 'post-1',
          telegramFileId: 'photo_file_123',
          telegramFileUniqueId: 'unique_photo_123',
          mediaType: MediaType.PHOTO,
          fileName: null,
          mimeType: 'image/jpeg',
          fileSize: null,
          caption: null,
          sortOrder: 1,
          createdAt: new Date(),
        },
      ];

      const payload = await renderer.render(longPost, mockTemplate, media);

      expect(payload.messages).toHaveLength(2);
      // Message 1: media with caption <= 1024
      expect(payload.messages[0]?.type).toBe('photo');
      expect(payload.messages[0]?.partIndex).toBe(0);
      expect(payload.messages[0]?.caption?.length).toBeLessThanOrEqual(
        TELEGRAM_LIMITS.MAX_CAPTION_LENGTH,
      );

      // Message 2: text with remainder <= 4096
      expect(payload.messages[1]?.type).toBe('text');
      expect(payload.messages[1]?.partIndex).toBe(1);
      expect(payload.messages[1]?.text?.length).toBeLessThanOrEqual(
        TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH,
      );
    });

    it('should render media group with caption on lead item', async () => {
      const mediaGroup: PostMedia[] = [
        {
          id: 'm1',
          postId: 'post-1',
          telegramFileId: 'photo_1',
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
          id: 'm2',
          postId: 'post-1',
          telegramFileId: 'photo_2',
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

      const payload = await renderer.render(basePost, mockTemplate, mediaGroup);

      expect(payload.messages).toHaveLength(1);
      const msg = payload.messages[0];
      expect(msg?.type).toBe('media_group');
      expect(msg?.items).toHaveLength(2);
      expect(msg?.items?.[0]?.caption).toBeDefined();
      expect(msg?.items?.[1]?.caption).toBeUndefined(); // Only first item has caption
    });
  });
});
