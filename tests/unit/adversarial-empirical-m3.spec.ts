import 'reflect-metadata';
import { HtmlSanitizer } from '../../src/modules/rendering/html-sanitizer.service';
import { HtmlSplitter } from '../../src/modules/rendering/html-splitter';
import { TelegramRenderer } from '../../src/modules/rendering/telegram-renderer.service';
import { Post, PostTemplate, PostMedia, MediaType, PostStatus } from '@prisma/client';
import { TELEGRAM_LIMITS } from '../../src/common/constants/telegram-limits';

describe('Milestone 3 Empirical Adversarial Stress Suite (m3_challenger_1)', () => {
  let sanitizer: HtmlSanitizer;
  let renderer: TelegramRenderer;

  beforeEach(() => {
    sanitizer = new HtmlSanitizer();
    renderer = new TelegramRenderer(sanitizer);
  });

  // =========================================================================
  // Dimension 1: Malicious Injection Challenge
  // =========================================================================
  describe('1. Malicious Injection Challenge', () => {
    it('1.1 should strip <script>alert(1)</script> and its inner contents', () => {
      const payload = 'Intro text <script>alert(1)</script> Outro text';
      const result = sanitizer.sanitize(payload);
      expect(result).not.toContain('<script');
      expect(result).not.toContain('</script>');
      expect(result).not.toContain('alert(1)');
      expect(result.replace(/\s+/g, ' ')).toBe('Intro text Outro text');
    });

    it('1.2 should strip uppercase and mixed-case <SCRIPT SRC="..."> tags', () => {
      const payload = 'Before <SCRIPT SRC="https://evil.com/xss.js">alert(2)</SCRIPT> After';
      const result = sanitizer.sanitize(payload);
      expect(result).not.toContain('<SCRIPT');
      expect(result).not.toContain('evil.com');
      expect(result).not.toContain('alert(2)');
      expect(result.replace(/\s+/g, ' ')).toBe('Before After');
    });

    it('1.3 should handle unclosed <script> tags without emitting runnable script', () => {
      const payload = 'Text <script>alert("unclosed")';
      const result = sanitizer.sanitize(payload);
      expect(result).not.toContain('<script');
      // When script is unclosed, tag itself is stripped as disallowed tag; alert is safe plain text
      expect(result).not.toContain('<script>');
    });

    it('1.4 should strip <iframe> and its inner contents', () => {
      const payload = 'Safe <iframe src="evil.com">hidden payload</iframe> End';
      const result = sanitizer.sanitize(payload);
      expect(result).not.toContain('<iframe');
      expect(result).not.toContain('</iframe>');
      expect(result).not.toContain('evil.com');
      expect(result).not.toContain('hidden payload');
      expect(result.replace(/\s+/g, ' ')).toBe('Safe End');
    });

    it('1.5 should strip <iframe src="javascript:alert(1)"> without closing tag', () => {
      const payload = 'Start <iframe src="javascript:alert(1)"> Fin';
      const result = sanitizer.sanitize(payload);
      expect(result).not.toContain('<iframe');
      expect(result).not.toContain('javascript:');
    });

    it('1.6 should strip <img src=x onerror=alert(1)> and never emit img or onerror', () => {
      const payload = 'Picture: <img src=x onerror=alert(1)> description';
      const result = sanitizer.sanitize(payload);
      expect(result).not.toContain('<img');
      expect(result).not.toContain('onerror');
      expect(result).not.toContain('alert(1)');
      expect(result.replace(/\s+/g, ' ')).toBe('Picture: description');
    });

    it('1.7 should strip self-closing <img src="x" onerror="alert(1)"/>', () => {
      const payload = '<img src="x" onerror="alert(1)"/>';
      const result = sanitizer.sanitize(payload);
      expect(result).not.toContain('<img');
      expect(result).not.toContain('onerror');
      expect(result).toBe('');
    });

    it('1.8 should disallow <a href="javascript:alert(1)"> and strip tag while preserving text', () => {
      const payload = 'Click <a href="javascript:alert(1)">here to win</a>!';
      const result = sanitizer.sanitize(payload);
      expect(result).not.toContain('href=');
      expect(result).not.toContain('javascript:');
      expect(result).not.toContain('<a>');
      expect(result).toBe('Click here to win!');
    });

    it('1.9 should disallow <a href="JAVASCRIPT:void(0)"> case-insensitively', () => {
      const payload = '<a href="JAVASCRIPT:void(0)">Link</a>';
      const result = sanitizer.sanitize(payload);
      expect(result).not.toContain('JAVASCRIPT');
      expect(result).toBe('Link');
    });

    it('1.10 should disallow data:, vbscript:, and file: URL schemes', () => {
      const dataUri = '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Data</a>';
      const vbUri = '<a href="vbscript:msgbox(1)">VBScript</a>';
      const fileUri = '<a href="file:///etc/passwd">File</a>';

      expect(sanitizer.sanitize(dataUri)).toBe('Data');
      expect(sanitizer.sanitize(vbUri)).toBe('VBScript');
      expect(sanitizer.sanitize(fileUri)).toBe('File');
    });

    it('1.11 should strip <div onclick="..."> and preserve inner text without events', () => {
      const payload = '<div onclick="alert(1)">Clickable Text</div>';
      const result = sanitizer.sanitize(payload);
      expect(result).not.toContain('<div');
      expect(result).not.toContain('onclick');
      expect(result).toBe('Clickable Text');
    });

    it('1.12 should strip event handlers from allowed tags like <b onmouseover="...">', () => {
      const payload = '<b onmouseover="alert(1)" id="b1" style="color:red">Bold Content</b>';
      const result = sanitizer.sanitize(payload);
      expect(result).toBe('<b>Bold Content</b>');
      expect(result).not.toContain('onmouseover');
      expect(result).not.toContain('style');
      expect(result).not.toContain('id');
    });

    it('1.13 should strip event handlers from <a> while retaining valid href', () => {
      const payload = '<a href="https://example.com" onclick="stealTokens()">Safe Link</a>';
      const result = sanitizer.sanitize(payload);
      expect(result).toBe('<a href="https://example.com">Safe Link</a>');
      expect(result).not.toContain('onclick');
      expect(result).not.toContain('stealTokens');
    });

    it('1.14 should strip <style>, <object>, and <embed> tags completely', () => {
      const stylePayload = '<style>body { display:none; }</style>Content';
      const objectPayload = '<object data="evil.swf">Flash</object>Visible';
      const embedPayload = '<embed src="evil.swf">Visible2';

      expect(sanitizer.sanitize(stylePayload)).toBe('Content');
      expect(sanitizer.sanitize(objectPayload)).toBe('Visible');
      expect(sanitizer.sanitize(embedPayload)).toBe('Visible2');
    });

    it('1.15 should neutralize nested tag injection attempts (<scr<script>ipt>)', () => {
      const payload = '<scr<script>alert(1)</script>ipt>Hello';
      const result = sanitizer.sanitize(payload);
      expect(result).not.toContain('<script');
      expect(result).not.toContain('alert(1)');
    });

    it('1.16 should preserve allowed tg:// and https:// and http:// links with escaped attributes', () => {
      const tgLink = '<a href="tg://resolve?domain=test_channel">Join Channel</a>';
      const httpsLink = '<a href="https://example.com/test?a=1&b=2">Web Link</a>';

      expect(sanitizer.sanitize(tgLink)).toBe('<a href="tg://resolve?domain=test_channel">Join Channel</a>');
      expect(sanitizer.sanitize(httpsLink)).toBe('<a href="https://example.com/test?a=1&amp;b=2">Web Link</a>');
    });

    it('1.17 should allow class="language-*" on code and pre, and strip disallowed classes or attributes', () => {
      const codeValid = '<code class="language-typescript">const x = 1;</code>';
      const preValid = '<pre class="language-python">print("hi")</pre>';
      const codeInvalid = '<code class="malicious-class" onclick="alert(1)">safe code</code>';

      expect(sanitizer.sanitize(codeValid)).toBe('<code class="language-typescript">const x = 1;</code>');
      expect(sanitizer.sanitize(preValid)).toBe('<pre class="language-python">print("hi")</pre>');
      expect(sanitizer.sanitize(codeInvalid)).toBe('<code>safe code</code>');
    });
  });

  // =========================================================================
  // Dimension 2: Unclosed, Malformed, and Tag Balancing Challenge
  // =========================================================================
  describe('2. Unclosed and Malformed HTML Tag Balancing Challenge', () => {
    it('2.1 should auto-close deeply unclosed tags in reverse LIFO order', () => {
      const payload = '<b><i><u><s><code><pre><blockquote>Deep Content';
      const result = sanitizer.sanitize(payload);
      expect(result).toBe('<b><i><u><s><code><pre><blockquote>Deep Content</blockquote></pre></code></s></u></i></b>');
    });

    it('2.2 should handle mismatched closing tags (e.g. <b>text</i>) safely', () => {
      const payload = '<b>text</i>';
      const result = sanitizer.sanitize(payload);
      // </i> is rogue closing tag (i is not in stack), so it is dropped; <b> is closed by LIFO unwind
      expect(result).toBe('<b>text</b>');
    });

    it('2.3 should ignore dangling closing tags with empty stack', () => {
      const payload = 'Rogue</b> closing</i> tags</a>';
      const result = sanitizer.sanitize(payload);
      expect(result).toBe('Rogue closing tags');
    });

    it('2.4 should properly balance overlapping tags (<b><i>Overlap</b></i>)', () => {
      const payload = '<b><i>Overlap</b></i>';
      const result = sanitizer.sanitize(payload);
      // When </b> is encountered, it unwinds 'i' then 'b', producing <b><i>Overlap</i></b>
      expect(result).toBe('<b><i>Overlap</i></b>');
    });

    it('2.5 should correctly unwind complex interlocking tags', () => {
      const payload = '<b>Level 1 <i>Level 2 <u>Level 3</b> Remainder 1</i> Remainder 2</u>';
      const result = sanitizer.sanitize(payload);
      // When </b> is hit, 'u' and 'i' are unwound before 'b', producing valid nested structure
      expect(result).toBe('<b>Level 1 <i>Level 2 <u>Level 3</u></i></b> Remainder 1 Remainder 2');
    });

    it('2.6 should escape raw <, >, and & characters without double-escaping entities', () => {
      const rawText = 'Formula: x < y & y > z. But &amp; and &lt; are already escaped!';
      const result = sanitizer.sanitize(rawText);
      expect(result).toBe('Formula: x &lt; y &amp; y &gt; z. But &amp; and &lt; are already escaped!');
    });

    it('2.7 should escape invalid or fake entities while preserving valid XML/Telegram entities', () => {
      const text = 'Valid: &amp; &lt; &gt; &quot; &apos;. Invalid: &fake; &unknown; &123; &Alone';
      const result = sanitizer.sanitize(text);
      expect(result).toContain('&amp; &lt; &gt; &quot; &apos;');
      expect(result).toContain('&amp;fake;');
      expect(result).toContain('&amp;unknown;');
      expect(result).toContain('&amp;Alone');
    });

    it('2.8 should strip disallowed layout tags and preserve text content', () => {
      const payload = '<div><p>Paragraph 1</p><section><span>Section <b>bold</b></span></section></div>';
      const result = sanitizer.sanitize(payload);
      expect(result).toBe('Paragraph 1Section <b>bold</b>');
    });

    it('2.9 should normalize HTML aliases to canonical Telegram tags', () => {
      const payload = '<strong>Bold</strong> <em>Italic</em> <ins>Underline</ins> <strike>Strike</strike> <del>Delete</del>';
      const result = sanitizer.sanitize(payload);
      expect(result).toBe('<b>Bold</b> <i>Italic</i> <u>Underline</u> <s>Strike</s> <s>Delete</s>');
    });

    it('2.10 should convert <br>, <br/>, and <br /> to newlines', () => {
      const payload = 'Line 1<br>Line 2<br/>Line 3<br />Line 4';
      const result = sanitizer.sanitize(payload);
      expect(result).toBe('Line 1\nLine 2\nLine 3\nLine 4');
    });

    it('2.11 should handle empty, null, and whitespace inputs gracefully', () => {
      expect(sanitizer.sanitize('')).toBe('');
      expect(sanitizer.sanitize(null as unknown as string)).toBe('');
      expect(sanitizer.sanitize(undefined as unknown as string)).toBe('');
      expect(sanitizer.sanitize('   ')).toBe('   ');
    });

    it('2.12 should handle malformed tags with unusual spacing or slash positions', () => {
      const payload = '<b >spaced</b> and <i / >slash</i>';
      const result = sanitizer.sanitize(payload);
      expect(result).toContain('<b>spaced</b>');
    });
  });

  // =========================================================================
  // Dimension 3: Multi-Message Boundary Splitting & TelegramRenderer Challenge
  // =========================================================================
  describe('3. Multi-Message Boundary Splitting Challenge', () => {
    it('3.1 should split text exceeding 4096 characters strictly at or under 4096', () => {
      const text = 'Paragraph start. ' + 'Word '.repeat(900) + 'Paragraph end.';
      expect(text.length).toBeGreaterThan(4500);

      const chunks = HtmlSplitter.splitIntoChunks(text, 4096);
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4096);
      }

      // Verify no content dropped (ignoring boundary whitespace trimming)
      const combined = chunks.join(' ').replace(/\s+/g, ' ');
      expect(combined).toContain('Paragraph start.');
      expect(combined).toContain('Paragraph end.');
    });

    it('3.2 should close active tags at 4096 boundary and reopen them in next chunk with attributes', () => {
      // Create a 5000 character string enclosed in bold, italic, and a link
      const innerContent = 'StyledText '.repeat(450); // ~5000 chars
      const longHtml = `<a href="https://example.com/target"><b><i>${innerContent}</i></b></a>`;

      const chunks = HtmlSplitter.splitIntoChunks(longHtml, 4096);
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      const chunk1 = chunks[0]!;
      const chunk2 = chunks[1]!;

      // Chunk 1 must be closed properly with reverse LIFO
      expect(chunk1.startsWith('<a href="https://example.com/target"><b><i>')).toBe(true);
      expect(chunk1.endsWith('</i></b></a>')).toBe(true);

      // Chunk 2 must reopen with exact same open tags and attributes
      expect(chunk2.startsWith('<a href="https://example.com/target"><b><i>')).toBe(true);
      expect(chunk2.endsWith('</i></b></a>')).toBe(true);
    });

    it('3.3 should split single media with caption > 1024 into media message (<=1024) and text message(s) (<=4096)', async () => {
      const mockTemplate: PostTemplate = {
        id: 'tpl-photo',
        key: 'photo_news',
        name: 'Photo News',
        description: 'Photo post',
        schemaJson: {
          fields: [
            { key: 'title', label: 'Title', type: 'text', required: true },
            { key: 'body', label: 'Body', type: 'rich_text', required: true },
          ],
        },
        renderConfig: {
          layout: '<b>{{title}}</b>\n\n{{body}}',
        },
        supportedMediaTypes: ['photo'],
        version: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // 2500 characters body
      const longBody = 'Detail sentence with insight. '.repeat(85);
      const post: Post = {
        id: 'post-media-1',
        channelId: 'chan-1',
        authorId: 'author-1',
        templateId: 'tpl-photo',
        templateVersion: 1,
        status: PostStatus.APPROVED,
        version: 1,
        scheduledAt: null,
        publishedAt: null,
        deletedAt: null,
        metadataJson: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        contentJson: {
          title: 'Photo Title',
          body: `<i>${longBody}</i>`,
        },
      };

      const media: PostMedia[] = [
        {
          id: 'med-1',
          postId: 'post-media-1',
          telegramFileId: 'photo_file_abc',
          telegramFileUniqueId: 'u_photo_abc',
          mediaType: MediaType.PHOTO,
          fileName: null,
          mimeType: 'image/jpeg',
          fileSize: BigInt(102400),
          caption: null,
          sortOrder: 1,
          createdAt: new Date(),
        },
      ];

      const payload = await renderer.render(post, mockTemplate, media);

      // Must produce at least 2 messages: Message 0 = photo with caption, Message 1 = text
      expect(payload.messages.length).toBeGreaterThanOrEqual(2);

      const msg0 = payload.messages[0]!;
      expect(msg0.type).toBe('photo');
      expect(msg0.partIndex).toBe(0);
      expect(msg0.fileId).toBe('photo_file_abc');
      expect(msg0.caption).toBeDefined();
      expect(msg0.caption!.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.MAX_CAPTION_LENGTH);
      // Verify caption has balanced tags
      expect(sanitizer.sanitize(msg0.caption!)).toBe(msg0.caption);

      const msg1 = payload.messages[1]!;
      expect(msg1.type).toBe('text');
      expect(msg1.partIndex).toBe(1);
      expect(msg1.text).toBeDefined();
      expect(msg1.text!.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH);
      // Verify text has balanced tags
      expect(sanitizer.sanitize(msg1.text!)).toBe(msg1.text);
    });

    it('3.4 should split media group (album) when caption exceeds 1024, placing lead caption on first item', async () => {
      const mockTemplate: PostTemplate = {
        id: 'tpl-album',
        key: 'album_post',
        name: 'Album Post',
        description: 'Multi-photo post',
        schemaJson: {
          fields: [
            { key: 'body', label: 'Body', type: 'rich_text', required: true },
          ],
        },
        renderConfig: {
          layout: '{{body}}',
        },
        supportedMediaTypes: ['photo'],
        version: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const longBody = 'Album description and narrative paragraph. '.repeat(40); // ~1700 chars
      const post: Post = {
        id: 'post-album-1',
        channelId: 'chan-1',
        authorId: 'author-1',
        templateId: 'tpl-album',
        templateVersion: 1,
        status: PostStatus.APPROVED,
        version: 1,
        scheduledAt: null,
        publishedAt: null,
        deletedAt: null,
        metadataJson: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        contentJson: {
          body: `<b>${longBody}</b>`,
        },
      };

      const mediaGroup: PostMedia[] = [
        {
          id: 'm1',
          postId: 'post-album-1',
          telegramFileId: 'album_photo_1',
          telegramFileUniqueId: 'u_1',
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
          postId: 'post-album-1',
          telegramFileId: 'album_photo_2',
          telegramFileUniqueId: 'u_2',
          mediaType: MediaType.PHOTO,
          fileName: null,
          mimeType: 'image/jpeg',
          fileSize: null,
          caption: null,
          sortOrder: 2,
          createdAt: new Date(),
        },
      ];

      const payload = await renderer.render(post, mockTemplate, mediaGroup);

      expect(payload.messages.length).toBeGreaterThanOrEqual(2);

      const msg0 = payload.messages[0]!;
      expect(msg0.type).toBe('media_group');
      expect(msg0.partIndex).toBe(0);
      expect(msg0.items).toHaveLength(2);
      expect(msg0.items![0]?.caption).toBeDefined();
      expect(msg0.items![0]!.caption!.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.MAX_CAPTION_LENGTH);
      // Items 1..N must NOT have caption in Telegram album
      expect(msg0.items![1]?.caption).toBeUndefined();

      const msg1 = payload.messages[1]!;
      expect(msg1.type).toBe('text');
      expect(msg1.partIndex).toBe(1);
      expect(msg1.text!.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH);
    });

    it('3.5 should handle massive posts (> 9000 chars) with media generating 3+ sequential messages', async () => {
      const mockTemplate: PostTemplate = {
        id: 'tpl-mega',
        key: 'mega_post',
        name: 'Mega Post',
        description: 'Huge text with media',
        schemaJson: {
          fields: [{ key: 'text', label: 'Text', type: 'rich_text', required: true }],
        },
        renderConfig: { layout: '{{text}}' },
        supportedMediaTypes: ['photo'],
        version: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const hugeText = 'Paragraph of valuable information.\n\n'.repeat(280); // ~9800 chars
      const post: Post = {
        id: 'post-huge',
        channelId: 'chan-1',
        authorId: 'author-1',
        templateId: 'tpl-mega',
        templateVersion: 1,
        status: PostStatus.APPROVED,
        version: 1,
        scheduledAt: null,
        publishedAt: null,
        deletedAt: null,
        metadataJson: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        contentJson: { text: hugeText },
      };

      const media: PostMedia[] = [
        {
          id: 'm1',
          postId: 'post-huge',
          telegramFileId: 'p1',
          telegramFileUniqueId: 'u1',
          mediaType: MediaType.PHOTO,
          fileName: null,
          mimeType: 'image/jpeg',
          fileSize: null,
          caption: null,
          sortOrder: 1,
          createdAt: new Date(),
        },
      ];

      const payload = await renderer.render(post, mockTemplate, media);

      // Part 0 is photo with <= 1024 caption, Part 1 is text <= 4096, Part 2 is text <= 4096, Part 3 ...
      expect(payload.messages.length).toBeGreaterThanOrEqual(3);
      expect(payload.messages[0]!.type).toBe('photo');
      expect(payload.messages[0]!.caption!.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.MAX_CAPTION_LENGTH);

      for (let i = 1; i < payload.messages.length; i++) {
        const msg = payload.messages[i]!;
        expect(msg.type).toBe('text');
        expect(msg.partIndex).toBe(i);
        expect(msg.text!.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH);
      }
    });

    it('3.6 should prefer natural paragraph and sentence boundaries when splitting', () => {
      const p1 = 'First long paragraph with important details. '.repeat(15);
      const p2 = 'Second paragraph starts here. '.repeat(15);
      const input = `${p1}\n\n${p2}`;

      const { part1, part2 } = HtmlSplitter.splitHtml(input, p1.length + 20);
      expect(part1).toBe(p1.trimEnd());
      expect(part2).toBe(p2.trimStart());
    });

    it('3.7 should never split inside an HTML entity (&amp; or &lt;)', () => {
      // Craft input where safeLimit lands right on an entity
      const prefix = 'A'.repeat(95);
      const input = prefix + '&amp;tail';
      // Limit 98 lands right inside &amp;
      const { part1, part2 } = HtmlSplitter.splitHtml(input, 98);
      expect(part1).not.toContain('&a');
      expect(part1.endsWith('&amp;') || !part1.endsWith('&')).toBe(true);
    });

    it('3.8 should handle pathological unbroken string of 5000 chars without infinite loop', () => {
      const unbroken = 'X'.repeat(5000);
      const chunks = HtmlSplitter.splitIntoChunks(unbroken, 4096);
      expect(chunks.length).toBe(2);
      expect(chunks[0]!.length).toBe(4096);
      expect(chunks[1]!.length).toBe(904);
    });

    it('3.10 should check part1 length with deep open tags near caption limit (1024)', () => {
      // Tags overhead: <b><i><u><a href="https://example.com">...</a></u></i></b>
      // Closing tags: </a></u></i></b> = 16 characters
      // Let's create content of 1500 characters
      const tagsOpen = '<a href="https://example.com"><b><i><u>';
      const tagsClose = '</u></i></b></a>';
      const words = 'TestingWord '.repeat(130); // ~1560 chars
      const html = `${tagsOpen}${words}${tagsClose}`;

      const { part1, part2 } = HtmlSplitter.splitHtml(html, 1024);
      console.log('3.10 part1 length:', part1.length);
      console.log('3.10 part2 length:', part2?.length);
      // Let's check whether part1 exceeds 1024
      expect(part1.length).toBeLessThanOrEqual(1024);
    });

    it('3.11 should check part1 length with deep open tags near message limit (4096)', () => {
      const tagsOpen = '<a href="https://example.com"><b><i><u><blockquote>';
      const tagsClose = '</blockquote></u></i></b></a>';
      const words = 'TestingMessageLimitWord '.repeat(200); // ~4800 chars
      const html = `${tagsOpen}${words}${tagsClose}`;

      const { part1, part2 } = HtmlSplitter.splitHtml(html, 4096);
      console.log('3.11 part1 length:', part1.length);
      console.log('3.11 part2 length:', part2?.length);
      expect(part1.length).toBeLessThanOrEqual(4096);
    });
  });
});
