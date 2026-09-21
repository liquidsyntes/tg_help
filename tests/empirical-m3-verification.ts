import 'reflect-metadata';
import { HtmlSanitizer } from '../src/modules/rendering/html-sanitizer.service';
import { HtmlSplitter } from '../src/modules/rendering/html-splitter';
import { TelegramRenderer } from '../src/modules/rendering/telegram-renderer.service';
import { Post, PostTemplate, PostMedia, MediaType, PostStatus } from '@prisma/client';
import { TELEGRAM_LIMITS } from '../src/common/constants/telegram-limits';

interface TestResult {
  name: string;
  category: string;
  passed: boolean;
  details: string;
  expected?: unknown;
  actual?: unknown;
}

const results: TestResult[] = [];

function assert(condition: boolean, name: string, category: string, details: string, expected?: unknown, actual?: unknown) {
  results.push({
    name,
    category,
    passed: condition,
    details,
    expected,
    actual,
  });
}

async function runEmpiricalSuite() {
  const sanitizer = new HtmlSanitizer();
  const renderer = new TelegramRenderer(sanitizer);

  console.log('================================================================');
  console.log('STARTING EMPIRICAL ADVERSARIAL CHALLENGE SUITE (M3)');
  console.log('================================================================\n');

  // ---------------------------------------------------------------------------
  // 1. Malicious Injection Challenge
  // ---------------------------------------------------------------------------
  console.log('>>> Testing Category 1: Malicious Injection Challenge');

  // 1.1 Standard script tag
  const s1 = sanitizer.sanitize('<script>alert(1)</script>');
  assert(
    !s1.includes('<script') && !s1.includes('alert(1)'),
    'Strip <script>alert(1)</script>',
    'Malicious Injection',
    `Output: "${s1}"`,
  );

  // 1.2 Uppercase script tag with src
  const s2 = sanitizer.sanitize('<SCRIPT SRC="https://evil.com/xss.js">alert(2)</SCRIPT>');
  assert(
    !s2.toLowerCase().includes('script') && !s2.includes('evil.com'),
    'Strip uppercase <SCRIPT SRC="...">',
    'Malicious Injection',
    `Output: "${s2}"`,
  );

  // 1.3 Unclosed script tag
  const s3 = sanitizer.sanitize('Start <script>alert(3) text');
  assert(
    !s3.includes('<script'),
    'Handle unclosed <script>',
    'Malicious Injection',
    `Output: "${s3}"`,
  );

  // 1.4 iframe tag
  const s4 = sanitizer.sanitize('<iframe src="evil.com">hidden payload</iframe>');
  assert(
    !s4.includes('<iframe') && !s4.includes('evil.com') && !s4.includes('hidden payload'),
    'Strip <iframe> and contents',
    'Malicious Injection',
    `Output: "${s4}"`,
  );

  // 1.5 iframe javascript URI
  const s5 = sanitizer.sanitize('<iframe src="javascript:alert(1)">');
  assert(
    !s5.includes('<iframe') && !s5.includes('javascript:'),
    'Strip <iframe src="javascript:...">',
    'Malicious Injection',
    `Output: "${s5}"`,
  );

  // 1.6 img with onerror
  const s6 = sanitizer.sanitize('<img src=x onerror=alert(1)>');
  assert(
    !s6.includes('<img') && !s6.includes('onerror') && !s6.includes('alert(1)'),
    'Strip <img src=x onerror=alert(1)>',
    'Malicious Injection',
    `Output: "${s6}"`,
  );

  // 1.7 self-closing img with onerror
  const s7 = sanitizer.sanitize('<img src="x" onerror="alert(1)"/>');
  assert(
    !s7.includes('<img') && !s7.includes('onerror'),
    'Strip self-closing <img .../>',
    'Malicious Injection',
    `Output: "${s7}"`,
  );

  // 1.8 a href javascript:
  const s8 = sanitizer.sanitize('<a href="javascript:alert(1)">Click Me</a>');
  assert(
    !s8.includes('href') && !s8.includes('javascript:') && s8.includes('Click Me'),
    'Disallow javascript: in <a href>',
    'Malicious Injection',
    `Output: "${s8}"`,
  );

  // 1.9 a href JAVASCRIPT: (case insensitive)
  const s9 = sanitizer.sanitize('<a href="JAVASCRIPT:void(0)">Link</a>');
  assert(
    !s9.toLowerCase().includes('javascript:') && s9.includes('Link'),
    'Disallow uppercase JAVASCRIPT: in <a href>',
    'Malicious Injection',
    `Output: "${s9}"`,
  );

  // 1.10 data:, vbscript:, file: URLs
  const s10a = sanitizer.sanitize('<a href="data:text/html;base64,PHNjcmlwdD4=">Data</a>');
  const s10b = sanitizer.sanitize('<a href="vbscript:msgbox(1)">VBScript</a>');
  const s10c = sanitizer.sanitize('<a href="file:///etc/passwd">File</a>');
  assert(
    !s10a.includes('data:') && !s10b.includes('vbscript:') && !s10c.includes('file:'),
    'Disallow data:, vbscript:, file: URLs',
    'Malicious Injection',
    `s10a="${s10a}", s10b="${s10b}", s10c="${s10c}"`,
  );

  // 1.11 div onclick
  const s11 = sanitizer.sanitize('<div onclick="alert(1)">Clickable Text</div>');
  assert(
    !s11.includes('<div') && !s11.includes('onclick') && s11.includes('Clickable Text'),
    'Strip <div onclick="..."> and retain inner text',
    'Malicious Injection',
    `Output: "${s11}"`,
  );

  // 1.12 b onmouseover (event handler on allowed tag)
  const s12 = sanitizer.sanitize('<b onmouseover="alert(1)" id="b1" style="color:red">Bold Content</b>');
  assert(
    s12 === '<b>Bold Content</b>',
    'Strip event handlers and disallowed attributes on <b>',
    'Malicious Injection',
    `Output: "${s12}"`,
    '<b>Bold Content</b>',
    s12,
  );

  // 1.13 a onclick (event handler on <a>)
  const s13 = sanitizer.sanitize('<a href="https://example.com" onclick="steal()">Safe Link</a>');
  assert(
    s13 === '<a href="https://example.com">Safe Link</a>',
    'Strip onclick from <a> while retaining valid href',
    'Malicious Injection',
    `Output: "${s13}"`,
  );

  // 1.14 style, object, embed
  const s14a = sanitizer.sanitize('<style>body { display:none; }</style>Content');
  const s14b = sanitizer.sanitize('<object data="evil.swf">Flash</object>Visible');
  const s14c = sanitizer.sanitize('<embed src="evil.swf">Visible2');
  assert(
    !s14a.includes('<style') && !s14b.includes('<object') && !s14c.includes('<embed'),
    'Strip <style>, <object>, <embed>',
    'Malicious Injection',
    `s14a="${s14a}", s14b="${s14b}", s14c="${s14c}"`,
  );

  // 1.15 Tag smuggling <scr<script>ipt>
  const s15 = sanitizer.sanitize('<scr<script>alert(1)</script>ipt>Hello');
  assert(
    !s15.includes('<script') && !s15.includes('alert(1)'),
    'Neutralize tag smuggling <scr<script>ipt>',
    'Malicious Injection',
    `Output: "${s15}"`,
  );

  // 1.16 Allowed tg:// and https:// URLs with attribute escaping
  const s16a = sanitizer.sanitize('<a href="tg://resolve?domain=test_channel">Join Channel</a>');
  const s16b = sanitizer.sanitize('<a href="https://example.com/test?a=1&b=2">Web Link</a>');
  assert(
    s16a === '<a href="tg://resolve?domain=test_channel">Join Channel</a>' &&
    s16b === '<a href="https://example.com/test?a=1&amp;b=2">Web Link</a>',
    'Allow tg:// and https:// links and escape & in href',
    'Malicious Injection',
    `s16a="${s16a}", s16b="${s16b}"`,
  );

  // 1.17 Allowed class="language-*" on code and pre
  const s17a = sanitizer.sanitize('<code class="language-typescript">const x = 1;</code>');
  const s17b = sanitizer.sanitize('<pre class="language-python">print("hi")</pre>');
  const s17c = sanitizer.sanitize('<code class="malicious-class" onclick="alert(1)">safe code</code>');
  assert(
    s17a === '<code class="language-typescript">const x = 1;</code>' &&
    s17b === '<pre class="language-python">print("hi")</pre>' &&
    s17c === '<code>safe code</code>',
    'Allow class="language-*" on code/pre and strip disallowed classes',
    'Malicious Injection',
    `s17a="${s17a}", s17b="${s17b}", s17c="${s17c}"`,
  );

  // ---------------------------------------------------------------------------
  // 2. Unclosed and Malformed HTML Tag Balancing Challenge
  // ---------------------------------------------------------------------------
  console.log('\n>>> Testing Category 2: Tag Balancing & Malformed HTML Challenge');

  // 2.1 Deeply unclosed tags
  const b1 = sanitizer.sanitize('<b><i><u><s><code><pre><blockquote>Deep Content');
  const expectedB1 = '<b><i><u><s><code><pre><blockquote>Deep Content</blockquote></pre></code></s></u></i></b>';
  assert(
    b1 === expectedB1,
    'Auto-close deeply unclosed tags in reverse LIFO order',
    'Tag Balancing',
    `Output: "${b1}"`,
    expectedB1,
    b1,
  );

  // 2.2 Mismatched closing tags (<b>text</i>)
  const b2 = sanitizer.sanitize('<b>text</i>');
  assert(
    b2 === '<b>text</b>',
    'Handle mismatched closing tags (<b>text</i>)',
    'Tag Balancing',
    `Output: "${b2}"`,
    '<b>text</b>',
    b2,
  );

  // 2.3 Dangling closing tags with empty stack
  const b3 = sanitizer.sanitize('Rogue</b> closing</i> tags</a>');
  assert(
    b3 === 'Rogue closing tags',
    'Ignore dangling closing tags with empty stack',
    'Tag Balancing',
    `Output: "${b3}"`,
    'Rogue closing tags',
    b3,
  );

  // 2.4 Overlapping tags <b><i>Overlap</b></i>
  const b4 = sanitizer.sanitize('<b><i>Overlap</b></i>');
  assert(
    b4 === '<b><i>Overlap</i></b>',
    'Properly balance overlapping tags (<b><i>Overlap</b></i>)',
    'Tag Balancing',
    `Output: "${b4}"`,
    '<b><i>Overlap</i></b>',
    b4,
  );

  // 2.5 Complex interlocking tags
  const b5 = sanitizer.sanitize('<b>Level 1 <i>Level 2 <u>Level 3</b> Remainder 1</i> Remainder 2</u>');
  assert(
    b5 === '<b>Level 1 <i>Level 2 <u>Level 3</u></i></b> Remainder 1 Remainder 2',
    'Unwind stack on early closing of parent tag',
    'Tag Balancing',
    `Output: "${b5}"`,
    '<b>Level 1 <i>Level 2 <u>Level 3</u></i></b> Remainder 1 Remainder 2',
    b5,
  );

  // 2.6 Raw entity characters escaping without double-escaping
  const b6 = sanitizer.sanitize('Formula: x < y & y > z. But &amp; and &lt; are already escaped!');
  const expectedB6 = 'Formula: x &lt; y &amp; y &gt; z. But &amp; and &lt; are already escaped!';
  assert(
    b6 === expectedB6,
    'Escape raw <, >, & without double-escaping valid entities',
    'Tag Balancing',
    `Output: "${b6}"`,
    expectedB6,
    b6,
  );

  // 2.7 Invalid entities escaping
  const b7 = sanitizer.sanitize('Valid: &amp; &lt; &gt; &quot; &apos;. Invalid: &fake; &unknown; &123; &Alone');
  assert(
    b7.includes('&amp; &lt; &gt; &quot; &apos;') &&
    b7.includes('&amp;fake;') &&
    b7.includes('&amp;unknown;') &&
    b7.includes('&amp;Alone'),
    'Escape invalid/unrecognized entities',
    'Tag Balancing',
    `Output: "${b7}"`,
  );

  // 2.8 Disallowed layout tags
  const b8 = sanitizer.sanitize('<div><p>Paragraph 1</p><section><span>Section <b>bold</b></span></section></div>');
  assert(
    b8 === 'Paragraph 1Section <b>bold</b>',
    'Strip disallowed layout tags (div, p, section, span)',
    'Tag Balancing',
    `Output: "${b8}"`,
    'Paragraph 1Section <b>bold</b>',
    b8,
  );

  // 2.9 Tag aliases normalization
  const b9 = sanitizer.sanitize('<strong>Bold</strong> <em>Italic</em> <ins>Underline</ins> <strike>Strike</strike> <del>Delete</del>');
  assert(
    b9 === '<b>Bold</b> <i>Italic</i> <u>Underline</u> <s>Strike</s> <s>Delete</s>',
    'Normalize HTML aliases (strong, em, ins, strike, del)',
    'Tag Balancing',
    `Output: "${b9}"`,
  );

  // 2.10 <br> and <br/> conversion
  const b10 = sanitizer.sanitize('Line 1<br>Line 2<br/>Line 3<br />Line 4');
  assert(
    b10 === 'Line 1\nLine 2\nLine 3\nLine 4',
    'Convert <br>, <br/>, <br /> to newlines',
    'Tag Balancing',
    `Output: "${b10}"`,
  );

  // 2.11 Empty, null, undefined input
  const b11a = sanitizer.sanitize('');
  const b11b = sanitizer.sanitize(null as unknown as string);
  const b11c = sanitizer.sanitize(undefined as unknown as string);
  assert(
    b11a === '' && b11b === '' && b11c === '',
    'Handle empty, null, undefined gracefully',
    'Tag Balancing',
    `b11a="${b11a}", b11b="${b11b}", b11c="${b11c}"`,
  );

  // 2.12 Incomplete tag at EOF
  const b12 = sanitizer.sanitize('Hello <b');
  assert(
    !b12.includes('<b') || b12.includes('&lt;b') || b12 === 'Hello ',
    'Handle incomplete tag at end of string without crashing',
    'Tag Balancing',
    `Output: "${b12}"`,
  );

  // ---------------------------------------------------------------------------
  // 3. Multi-Message Boundary Splitting Challenge
  // ---------------------------------------------------------------------------
  console.log('\n>>> Testing Category 3: Multi-Message Boundary Splitting Challenge');

  // 3.1 Plain text splitting at natural boundaries
  const text4500 = 'Paragraph start. ' + 'Word '.repeat(900) + 'Paragraph end.';
  const chunks31 = HtmlSplitter.splitIntoChunks(text4500, 4096);
  assert(
    chunks31.length >= 2,
    'Plain text > 4096 splits into multiple chunks',
    'Boundary Splitting',
    `Chunks count: ${chunks31.length}`,
  );
  let allChunksUnder4096 = true;
  chunks31.forEach((c, idx) => {
    if (c.length > 4096) {
      allChunksUnder4096 = false;
      console.log(`CHUNK ${idx} OVERFLOW: ${c.length} > 4096`);
    }
  });
  assert(
    allChunksUnder4096,
    'Plain text chunks are all <= 4096',
    'Boundary Splitting',
    `Chunk lengths: ${chunks31.map(c => c.length).join(', ')}`,
  );

  // 3.2 Active formatting tags closed at boundary and reopened in chunk 2
  const innerFormatted = 'StyledText '.repeat(450); // ~4950 chars
  const formatted5000 = `<a href="https://example.com/target"><b><i>${innerFormatted}</i></b></a>`;
  const chunks32 = HtmlSplitter.splitIntoChunks(formatted5000, 4096);
  assert(
    chunks32.length >= 2,
    'Formatted HTML > 4096 splits into multiple chunks',
    'Boundary Splitting',
    `Chunks count: ${chunks32.length}`,
  );
  const c1 = chunks32[0]!;
  const c2 = chunks32[1]!;
  assert(
    c1.startsWith('<a href="https://example.com/target"><b><i>') &&
    c1.endsWith('</i></b></a>'),
    'Chunk 1 closes active tags in reverse LIFO at split boundary',
    'Boundary Splitting',
    `c1 start: ${c1.slice(0, 50)}, c1 end: ${c1.slice(-25)}`,
  );
  assert(
    c2.startsWith('<a href="https://example.com/target"><b><i>') &&
    c2.endsWith('</i></b></a>'),
    'Chunk 2 reopens active tags with attributes at start',
    'Boundary Splitting',
    `c2 start: ${c2.slice(0, 50)}, c2 end: ${c2.slice(-25)}`,
  );

  // 3.3 STRESS TEST: Open tags near 1024 caption limit (Bug inspection)
  const tagsOpen1024 = '<a href="https://example.com/very/long/url/path"><b><i><u>';
  const tagsClose1024 = '</u></i></b></a>';
  const words1024 = 'WordItem '.repeat(140); // ~1260 chars
  const htmlCaptionStress = `${tagsOpen1024}${words1024}${tagsClose1024}`;
  const splitCaptionRes = HtmlSplitter.splitHtml(htmlCaptionStress, 1024);
  const part1CapLen = splitCaptionRes.part1.length;
  console.log(`STRESS 3.3: Caption split limit: 1024. Part1 length: ${part1CapLen}. Over limit by: ${part1CapLen - 1024}`);
  assert(
    part1CapLen <= 1024,
    'Caption split part1 length MUST be <= 1024 (TELEGRAM LIMIT)',
    'Boundary Splitting (STRESS)',
    `part1 length = ${part1CapLen} (limit 1024)`,
    '<= 1024',
    part1CapLen,
  );

  // 3.4 STRESS TEST: Open tags near 4096 message limit (Bug inspection)
  const tagsOpen4096 = '<a href="https://example.com/target/path"><b><i><u><blockquote>';
  const tagsClose4096 = '</blockquote></u></i></b></a>';
  const words4096 = 'LongMessageWord '.repeat(280); // ~4480 chars
  const htmlMessageStress = `${tagsOpen4096}${words4096}${tagsClose4096}`;
  const splitMsgRes = HtmlSplitter.splitHtml(htmlMessageStress, 4096);
  const part1MsgLen = splitMsgRes.part1.length;
  console.log(`STRESS 3.4: Message split limit: 4096. Part1 length: ${part1MsgLen}. Over limit by: ${part1MsgLen - 4096}`);
  assert(
    part1MsgLen <= 4096,
    'Message split part1 length MUST be <= 4096 (TELEGRAM LIMIT)',
    'Boundary Splitting (STRESS)',
    `part1 length = ${part1MsgLen} (limit 4096)`,
    '<= 4096',
    part1MsgLen,
  );

  // 3.4b STRESS TEST: TelegramRenderer caption overflow under htmlCaptionStress
  const captionOverflowPost: Post = {
    id: 'post-cap-overflow',
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
      title: 'Title',
      body: htmlCaptionStress,
    },
  };
  const captionOverflowTemplate: PostTemplate = {
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
    renderConfig: { layout: '{{body}}' },
    supportedMediaTypes: ['photo'],
    version: 1,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const captionOverflowMedia: PostMedia[] = [
    {
      id: 'med-overflow',
      postId: 'post-cap-overflow',
      telegramFileId: 'photo_overflow',
      telegramFileUniqueId: 'u_photo_overflow',
      mediaType: MediaType.PHOTO,
      fileName: null,
      mimeType: 'image/jpeg',
      fileSize: BigInt(102400),
      caption: null,
      sortOrder: 1,
      createdAt: new Date(),
    },
  ];
  const payloadCaptionOverflow = await renderer.render(captionOverflowPost, captionOverflowTemplate, captionOverflowMedia);
  const renderedCapLen = payloadCaptionOverflow.messages[0]?.caption?.length ?? 0;
  console.log(`STRESS 3.4b: TelegramRenderer message 0 caption length: ${renderedCapLen}. Over limit by: ${renderedCapLen - 1024}`);
  assert(
    renderedCapLen <= 1024,
    'TelegramRenderer Message 0 caption length MUST be <= 1024 (TELEGRAM LIMIT)',
    'TelegramRenderer (STRESS)',
    `caption length = ${renderedCapLen} (limit 1024)`,
    '<= 1024',
    renderedCapLen,
  );

  // 3.5 TelegramRenderer with single media and long caption (>1024)
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

  const longBody = 'Detail sentence with insight. '.repeat(85); // ~2550 chars
  const postWithPhoto: Post = {
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

  const mediaPhoto: PostMedia[] = [
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

  const payloadPhoto = await renderer.render(postWithPhoto, mockTemplate, mediaPhoto);
  assert(
    payloadPhoto.messages.length >= 2,
    'Single media with text > 1024 splits into at least 2 messages',
    'TelegramRenderer',
    `Messages count: ${payloadPhoto.messages.length}`,
  );
  const msg0 = payloadPhoto.messages[0]!;
  assert(
    msg0.type === 'photo' && msg0.fileId === 'photo_file_abc',
    'Message 0 has type photo and fileId',
    'TelegramRenderer',
    `type: ${msg0.type}, fileId: ${msg0.fileId}`,
  );
  assert(
    msg0.caption !== undefined && msg0.caption.length <= TELEGRAM_LIMITS.MAX_CAPTION_LENGTH,
    `Message 0 caption length (${msg0.caption?.length}) <= MAX_CAPTION_LENGTH (1024)`,
    'TelegramRenderer',
    `caption length: ${msg0.caption?.length}`,
    '<= 1024',
    msg0.caption?.length,
  );
  const msg1 = payloadPhoto.messages[1]!;
  assert(
    msg1.type === 'text' && msg1.text !== undefined && msg1.text.length <= TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH,
    `Message 1 text length (${msg1.text?.length}) <= MAX_MESSAGE_LENGTH (4096)`,
    'TelegramRenderer',
    `text length: ${msg1.text?.length}`,
    '<= 4096',
    msg1.text?.length,
  );

  // 3.6 Media group with long caption (>1024)
  const mediaGroup: PostMedia[] = [
    {
      id: 'm1',
      postId: 'post-media-1',
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
    {
      id: 'm2',
      postId: 'post-media-1',
      telegramFileId: 'p2',
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

  const payloadAlbum = await renderer.render(postWithPhoto, mockTemplate, mediaGroup);
  assert(
    payloadAlbum.messages.length >= 2,
    'Media group with text > 1024 splits into media_group + text messages',
    'TelegramRenderer',
    `Messages count: ${payloadAlbum.messages.length}`,
  );
  const albumMsg = payloadAlbum.messages[0]!;
  assert(
    albumMsg.type === 'media_group' && albumMsg.items?.length === 2,
    'Message 0 is media_group with 2 items',
    'TelegramRenderer',
    `type: ${albumMsg.type}, items: ${albumMsg.items?.length}`,
  );
  assert(
    albumMsg.items?.[0]?.caption !== undefined &&
    albumMsg.items[0]!.caption!.length <= TELEGRAM_LIMITS.MAX_CAPTION_LENGTH,
    `Lead item caption length (${albumMsg.items?.[0]?.caption?.length}) <= MAX_CAPTION_LENGTH (1024)`,
    'TelegramRenderer',
    `lead caption length: ${albumMsg.items?.[0]?.caption?.length}`,
    '<= 1024',
    albumMsg.items?.[0]?.caption?.length,
  );
  assert(
    albumMsg.items?.[1]?.caption === undefined,
    'Non-lead album item has undefined caption (Telegram album invariant)',
    'TelegramRenderer',
    `item 1 caption: ${albumMsg.items?.[1]?.caption}`,
  );

  // 3.7 Massive post (9000+ chars) with media
  const massiveBody = 'Information section with full details and analysis.\n\n'.repeat(220); // ~11660 chars
  const massivePost: Post = {
    ...postWithPhoto,
    contentJson: {
      title: 'Massive Editorial Post',
      body: `<b>${massiveBody}</b>`,
    },
  };
  const payloadMassive = await renderer.render(massivePost, mockTemplate, mediaPhoto);
  assert(
    payloadMassive.messages.length >= 3,
    'Massive post (>9000 chars) with media splits into 3+ messages',
    'TelegramRenderer',
    `Messages count: ${payloadMassive.messages.length}`,
  );
  let allMassiveUnderLimit = true;
  payloadMassive.messages.forEach((m, idx) => {
    if (idx === 0) {
      if ((m.caption?.length ?? 0) > TELEGRAM_LIMITS.MAX_CAPTION_LENGTH) {
        allMassiveUnderLimit = false;
        console.log(`MASSIVE MESSAGE 0 CAPTION OVERFLOW: ${m.caption?.length} > 1024`);
      }
    } else {
      if ((m.text?.length ?? 0) > TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH) {
        allMassiveUnderLimit = false;
        console.log(`MASSIVE MESSAGE ${idx} TEXT OVERFLOW: ${m.text?.length} > 4096`);
      }
    }
  });
  assert(
    allMassiveUnderLimit,
    'All messages in massive post strictly respect Telegram limits (caption <= 1024, text <= 4096)',
    'TelegramRenderer',
    `Message lengths: ${payloadMassive.messages.map(m => m.caption?.length ?? m.text?.length).join(', ')}`,
  );

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log('CHALLENGE SUITE RESULTS SUMMARY:');
  console.log('================================================================');

  let passedCount = 0;
  let failedCount = 0;

  for (const r of results) {
    if (r.passed) {
      passedCount++;
      console.log(`[PASS] [${r.category}] ${r.name}`);
    } else {
      failedCount++;
      console.log(`[FAIL] [${r.category}] ${r.name}`);
      console.log(`       Details: ${r.details}`);
      if (r.expected !== undefined) console.log(`       Expected: ${JSON.stringify(r.expected)}`);
      if (r.actual !== undefined) console.log(`       Actual:   ${JSON.stringify(r.actual)}`);
    }
  }

  console.log(`\nTotal tests: ${results.length}`);
  console.log(`Passed:      ${passedCount}`);
  console.log(`Failed:      ${failedCount}`);

  if (failedCount > 0) {
    console.log('\nVERDICT: REQUEST_CHANGES (Defects found in empirical challenge)');
  } else {
    console.log('\nVERDICT: APPROVE');
  }
}

runEmpiricalSuite().catch(console.error);
