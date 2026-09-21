# Milestone 3 Investigation Report: TelegramRenderer, HtmlSanitizer & Multi-Message Splitting

**Author**: `m3_explorer_2` (teamwork_preview_explorer)  
**Date**: 2026-09-21  
**Working Directory**: `c:/TgHelp/.agents/m3_explorer_2`  
**Target Milestone**: Milestone 3 (Templates, Canonical Rendering & Media)  
**Scope**: HTML Sanitizer, Canonical TelegramRenderer, Multi-Message Splitting, TelegramPayload Interfaces & Worker Execution Strategy.

---

## 1. Executive Summary

In accordance with **AGENTS.md (§15, §16, §17, §18)**, **tasks.md (§15, §16, §17, §18)**, and **PROJECT.md (F-18, F-19, F-20)**, this report establishes the complete architectural and algorithmic specification for:
1. **`HtmlSanitizer`**: A deterministic, stack-balanced HTML sanitizer conforming to Telegram Bot API HTML parse mode constraints, stripping dangerous scripts/handlers, restricting attributes on `<a>` to verified safe URIs (`https://`, `http://`, `tg://`), escaping unescaped `<, >, &` entities, and ensuring 100% tag balance.
2. **`TelegramRenderer`**: The single canonical rendering pipeline that transforms `Post + PostTemplate + PostMedia[]` into a structured, multi-message `TelegramPayload`. Preview in the editorial bot and publication to the channel utilize the **exact same renderer**, guaranteeing complete visual and structural fidelity.
3. **`Multi-Message Splitting Engine`**: A split algorithm enforcing Telegram's strict bounds (`MAX_CAPTION_LENGTH = 1024`, `MAX_MESSAGE_LENGTH = 4096`). When media is attached and rendered content exceeds 1024 characters, the engine seamlessly partitions the publication into Message 1 (Media / Media Group with title/summary caption $\le 1024$) and Message 2 (Remaining rich text body $\le 4096$), automatically closing and reopening active HTML tags across split boundaries.
4. **Worker Publishing Integration**: A structured payload schema enabling durable, step-by-step recording of sent message IDs in PostgreSQL (`publication_jobs.telegram_message_ids`), guaranteeing idempotent partial-publishing resumes without duplicating media or text.

---

## 2. Design of `HtmlSanitizer` (F-19, AGENTS.md §17, tasks.md §17)

### 2.1 Telegram Bot API HTML Specifications
Telegram Bot API supports a strict subset of HTML tags in `parse_mode: 'HTML'`:
- **Allowed formatting tags**: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`.
- **Allowed aliases (normalized to canonical)**:
  - `<strong>` $\rightarrow$ `<b>`
  - `<em>` $\rightarrow$ `<i>`
  - `<ins>` $\rightarrow$ `<u>`
  - `<strike>`, `<del>` $\rightarrow$ `<s>`
- **Allowed attributes**:
  - `<a>`: ONLY `href`. Protocol **must** match `^https?://|^tg://`. Prohibited schemes: `javascript:`, `data:`, `vbscript:`, `file:`.
  - `<pre>` / `<code>`: optional `class="language-..."` can be preserved; all other attributes stripped.
  - All other tags (`b`, `i`, `u`, `s`, `blockquote`): **NO attributes allowed**. Any attributes (e.g. `style`, `id`, `class`, event handlers `onclick`, `onerror`) must be stripped.
- **Prohibited / Dangerous Tags**:
  - Executable/malicious blocks (`<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`): **Tag and all inner contents must be completely stripped**.
  - Non-Telegram layout tags (`<div>`, `<p>`, `<span>`, `<h1>`-`<h6>`, `<table>`, `<tr>`, `<td>`, `<ul>`, `<ol>`, `<li>`, `<img>`, `<hr>`): **Tags stripped while inner text content is preserved**.
- **Entities & Character Escaping**:
  - Outside of allowed tags, `<` must be escaped to `&lt;`, `>` to `&gt;`, and `&` to `&amp;`.
  - Already-escaped valid entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`) must **not** be double-escaped to `&amp;amp;`.

### 2.2 Tag Balancing & Nesting Algorithm
Telegram rejects updates containing unclosed tags (`<b>text`) or overlapping/improperly nested tags (`<b><i>text</b></i>`) with `400 Bad Request: can't parse entities`.

#### Stack-Based Parser Architecture:
```text
Raw String
   ↓
Lexical Tokenizer (Text | Tag | Comment)
   ↓
Tag Filter & Attribute Sanitizer
   ↓
LIFO Tag Stack Validation
   ↓
Unclosed Tags Auto-Closer (Stack Unwind)
   ↓
Sanitized Telegram HTML
```

#### Deterministic Implementation Blueprint:
```typescript
export interface SanitizerOptions {
  allowedTags?: string[];
  normalizeAliases?: boolean;
}

export class HtmlSanitizer {
  private static readonly ALLOWED_TAGS = new Set([
    'b', 'strong',
    'i', 'em',
    'u', 'ins',
    's', 'strike', 'del',
    'code',
    'pre',
    'a',
    'blockquote',
  ]);

  private static readonly TAG_NORMALIZATION: Record<string, string> = {
    strong: 'b',
    em: 'i',
    ins: 'u',
    strike: 's',
    del: 's',
  };

  /**
   * Primary sanitization entrypoint.
   * Strips dangerous tags/handlers, validates attributes, escapes raw entities,
   * and balances open tags.
   */
  public sanitize(rawHtml: string): string {
    if (!rawHtml || typeof rawHtml !== 'string') return '';

    // 1. Strip script, style, iframe including content
    let clean = rawHtml
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/\son\w+="[^"]*"/gi, '')
      .replace(/\son\w+='[^']*'/gi, '');

    // 2. Tokenize and balance tags
    const tagRegex = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*?)?>/g;
    const tagStack: string[] = [];
    let lastIndex = 0;
    let result = '';
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(clean)) !== null) {
      const matchIndex = match.index;
      const fullTag = match[0];
      const rawTagName = match[1].toLowerCase();
      const isClosing = fullTag.startsWith('</');

      // Process text segment preceding the tag: escape raw &, <, >
      const textSegment = clean.slice(lastIndex, matchIndex);
      if (textSegment.length > 0) {
        result += this.escapeTextSegment(textSegment);
      }
      lastIndex = tagRegex.lastIndex;

      if (!HtmlSanitizer.ALLOWED_TAGS.has(rawTagName)) {
        // Unsupported tag: strip tag itself, inner text preserved in subsequent loops
        continue;
      }

      const canonicalTag = HtmlSanitizer.TAG_NORMALIZATION[rawTagName] ?? rawTagName;

      if (isClosing) {
        // If closing tag matches current top of stack, close it
        const top = tagStack[tagStack.length - 1];
        if (top === canonicalTag) {
          tagStack.pop();
          result += `</${canonicalTag}>`;
        } else if (tagStack.includes(canonicalTag)) {
          // Mis-nested closing tag: unwind stack until matching tag
          while (tagStack.length > 0) {
            const popped = tagStack.pop()!;
            result += `</${popped}>`;
            if (popped === canonicalTag) break;
          }
        }
        // If tag wasn't open in stack, drop the rogue closing tag
      } else {
        // Opening tag: sanitize attributes
        let sanitizedOpenTag = `<${canonicalTag}>`;

        if (canonicalTag === 'a') {
          const hrefMatch = fullTag.match(/href=["']([^"']*)["']/i);
          const href = hrefMatch ? hrefMatch[1].trim() : '';
          if (this.isValidHref(href)) {
            sanitizedOpenTag = `<a href="${this.escapeAttribute(href)}">`;
          } else {
            // Invalid href: strip <a> entirely, preserving inner text
            continue;
          }
        }

        tagStack.push(canonicalTag);
        result += sanitizedOpenTag;
      }
    }

    // Process trailing text segment
    if (lastIndex < clean.length) {
      result += this.escapeTextSegment(clean.slice(lastIndex));
    }

    // Auto-close any unclosed tags remaining in stack (LIFO unwind)
    while (tagStack.length > 0) {
      const remainingTag = tagStack.pop()!;
      result += `</${remainingTag}>`;
    }

    return result;
  }

  /**
   * Escapes unescaped &, <, > without double-escaping existing valid entities.
   */
  public escapeTextSegment(text: string): string {
    return text
      .replace(/&(?!amp;|lt;|gt;|quot;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  public escapeText(plainText: string): string {
    if (!plainText) return '';
    return plainText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private isValidHref(href: string): boolean {
    if (!href) return false;
    const lower = href.toLowerCase();
    return lower.startsWith('https://') || lower.startsWith('http://') || lower.startsWith('tg://');
  }

  private escapeAttribute(attr: string): string {
    return attr.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
```

---

## 3. Design of `TelegramRenderer` (F-18, AGENTS.md §15, tasks.md §15)

### 3.1 The Canonical Pipeline Guarantee
**Rule (AGENTS.md §15)**: Preview and Publication **must use the exact same renderer**.
- `TelegramRenderer` is an injectable application service located in `src/modules/rendering/telegram-renderer.service.ts`.
- It takes standard domain models: `Post`, `PostTemplate`, and `PostMedia[]`.
- It outputs `TelegramPayload` containing a list of `TelegramOutgoingMessage` objects.
- **Preview Handler**: takes `TelegramPayload.messages`, renders them to the user's private Telegram chat, and appends the interactive editorial keyboard (`[Одобрить]`, `[На доработку]`, `[Редактировать]`).
- **Publication Worker**: takes `TelegramPayload.messages`, sends them sequentially to `channel.telegramChatId`, and records each assigned `telegramMessageId` to PostgreSQL.
- Because both consume the exact output of `TelegramRenderer.render()`, preview and channel publication never diverge.

### 3.2 Dynamic Template Layout Interpolation
Templates stored in PostgreSQL define a `renderConfig.layout` string with mustache-like placeholders (e.g. `<b>{{title}}</b>\n\n<i>{{lead}}</i>\n\n{{body}}\n\n{{tags}}\n\n{{cta}}`).

#### Layout Interpolation Steps:
1. **Field Sanitization**:
   - `rich_text` fields: sanitized through `HtmlSanitizer.sanitize()`.
   - `text` / `url` / `number` fields: escaped through `HtmlSanitizer.escapeText()`.
2. **Metadata Formatting**:
   - `tags`: If present as an array `["tech", "crypto"]`, formatted as `#tech #crypto`.
   - `cta`: If present, escaped.
3. **Placeholder Replacement**:
   - Replace all `{{key}}` in `layout` with their sanitized values.
4. **Conditional Cleanup of Omitted Optional Fields**:
   - When an optional field (e.g. `lead`) is empty or missing, placeholders like `<i>{{lead}}</i>` or `\n\n{{lead}}\n\n` must not leave orphan empty tags (`<i></i>`) or multiple blank lines.
   - Clean empty formatting tags: `/<(b|i|u|s|blockquote)>\s*<\/\1>/gi` $\rightarrow$ `""`.
   - Collapse excessive blank lines: `/\n{3,}/g` $\rightarrow$ `\n\n`.
5. **Final Sanitization Pass**:
   - Run the assembled text through `HtmlSanitizer.sanitize()` to ensure total structure validity.

---

## 4. Design of Multi-Message Splitting Engine (F-20, AGENTS.md §16, §18)

### 4.1 Constraint Matrix
| Content Combination | Total Text Length | Output Message Structure | Max Length Rules |
|---|---|---|---|
| **Text Only** (0 media) | $\le 4096$ chars | 1 message (`text`) | Message 1 $\le 4096$ |
| **Text Only** (0 media) | $> 4096$ chars | $N$ messages (`text`) | All Messages $\le 4096$ |
| **Single Media** (1 photo/video/doc) | $\le 1024$ chars | 1 message (`photo`/`video`/`doc`) with full caption | Caption $\le 1024$ |
| **Single Media** (1 photo/video/doc) | $> 1024$ chars | **Message 1**: Media with title/short caption<br>**Message 2**: Long text body | Caption $\le 1024$<br>Text $\le 4096$ |
| **Media Group** (2–10 photos/videos) | $\le 1024$ chars | 1 message (`media_group`) with caption on first item | Item 1 Caption $\le 1024$ |
| **Media Group** (2–10 photos/videos) | $> 1024$ chars | **Message 1**: Media Group with title/short caption<br>**Message 2**: Long text body | Item 1 Caption $\le 1024$<br>Text $\le 4096$ |

### 4.2 HTML-Aware Splitting Algorithm
A naive string split (`text.slice(0, 1024)`) breaks HTML parsing by:
1. Cutting through HTML tags (e.g. `<a hr` | `ef="...">`)
2. Cutting through entity codes (e.g. `&am` | `p;`)
3. Leaving open tags in Part 1 and orphan closing tags in Part 2.

#### The `HtmlSplitter` Algorithm:
```typescript
export interface SplitResult {
  part1: string;
  part2?: string;
}

export class HtmlSplitter {
  /**
   * Splits an HTML string at or before maxLength, respecting tag boundaries,
   * and properly balancing open tags between both parts.
   */
  public static splitHtml(html: string, maxLength: number): SplitResult {
    if (html.length <= maxLength) {
      return { part1: html };
    }

    // 1. Find optimal cut point <= maxLength
    const cutPoint = this.findOptimalCutPoint(html, maxLength);

    // 2. Determine open tags prior to cutPoint
    const activeTags = this.getActiveOpenTags(html.slice(0, cutPoint));

    // 3. Close open tags at end of Part 1 (in reverse)
    const closingSuffix = activeTags.slice().reverse().map(t => `</${t}>`).join('');
    const part1 = html.slice(0, cutPoint).trimEnd() + closingSuffix;

    // 4. Reopen active tags at start of Part 2
    const openingPrefix = activeTags.map(t => `<${t}>`).join('');
    const remainder = openingPrefix + html.slice(cutPoint).trimStart();

    return {
      part1,
      part2: remainder,
    };
  }

  /**
   * Locates a natural splitting boundary (paragraph break, line break, sentence, word)
   * strictly before maxLength, ensuring we do not cut inside <tag> or &entity;.
   */
  private static findOptimalCutPoint(html: string, maxLength: number): number {
    // Safety check: ensure maxLength does not fall inside an HTML tag
    let safeLimit = maxLength;
    const lastOpenAngle = html.lastIndexOf('<', safeLimit);
    const lastCloseAngle = html.lastIndexOf('>', safeLimit);
    if (lastOpenAngle > lastCloseAngle) {
      // safeLimit is inside a tag (<tag...>); pull limit back before '<'
      safeLimit = lastOpenAngle;
    }

    // Search for natural break points within the last 20% of safeLimit
    const minAcceptable = Math.floor(safeLimit * 0.75);
    const windowText = html.slice(minAcceptable, safeLimit);

    // 1. Paragraph break (\n\n)
    const paragraphBreak = windowText.lastIndexOf('\n\n');
    if (paragraphBreak !== -1) return minAcceptable + paragraphBreak + 2;

    // 2. Line break (\n)
    const lineBreak = windowText.lastIndexOf('\n');
    if (lineBreak !== -1) return minAcceptable + lineBreak + 1;

    // 3. Sentence end (. / ! / ?)
    const sentenceMatch = /(?<=[.!?])\s+/g;
    let match: RegExpExecArray | null;
    let lastSentenceEnd = -1;
    while ((match = sentenceMatch.exec(windowText)) !== null) {
      lastSentenceEnd = match.index + match[0].length;
    }
    if (lastSentenceEnd !== -1) return minAcceptable + lastSentenceEnd;

    // 4. Space / word boundary
    const spaceIndex = windowText.lastIndexOf(' ');
    if (spaceIndex !== -1) return minAcceptable + spaceIndex + 1;

    // Fallback: strict safe limit
    return safeLimit;
  }

  /**
   * Tracks unclosed tags up to the split position.
   */
  private static getActiveOpenTags(fragment: string): string[] {
    const tagRegex = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*?)?>/g;
    const stack: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(fragment)) !== null) {
      const fullTag = match[0];
      const tag = match[1].toLowerCase();
      if (fullTag.startsWith('</')) {
        const top = stack[stack.length - 1];
        if (top === tag) stack.pop();
      } else if (!fullTag.endsWith('/>')) {
        stack.push(tag);
      }
    }
    return stack;
  }
}
```

### 4.3 Partitioning Strategy for Media + Long Text
When a post contains media and rendered text exceeds 1024 characters:
1. **Title / Lead Partitioning**: If the template defines a distinct `title` (or `title` + `lead`), extract `title` as the short caption:
   `caption = sanitizeHtml(<b>${title}</b>)` (guaranteed $\le 1024$ chars).
   The remaining body + tags + CTA become Message 2 ($\le 4096$).
2. **Monolithic Text Partitioning**: If the post is freeform (e.g. single `body` text), use `HtmlSplitter.splitHtml(renderedText, 1020)`:
   - Part 1 becomes the media caption ($\le 1024$).
   - Part 2 becomes Message 2 text ($\le 4096$).
   - If Part 2 exceeds 4096 characters, recursively split Part 2 into Message 2 and Message 3.

---

## 5. Structured Payload Interfaces & DTOs (AGENTS.md §16)

```typescript
// src/modules/rendering/types/telegram-payload.types.ts

export type OutgoingMessageType =
  | 'text'
  | 'photo'
  | 'video'
  | 'document'
  | 'animation'
  | 'media_group';

export interface BaseOutgoingMessage {
  /** Unique sequence ID for worker idempotency tracking: e.g. "part-0", "part-1" */
  partIndex: number;
  type: OutgoingMessageType;
}

export interface TextOutgoingMessage extends BaseOutgoingMessage {
  type: 'text';
  text: string; // Sanitized Telegram HTML, max 4096 chars
  disableWebPagePreview?: boolean;
}

export interface SingleMediaOutgoingMessage extends BaseOutgoingMessage {
  type: 'photo' | 'video' | 'document' | 'animation';
  fileId: string;
  caption?: string; // Sanitized Telegram HTML, max 1024 chars
}

export interface MediaGroupItem {
  type: 'photo' | 'video' | 'document';
  fileId: string;
  caption?: string; // Only first item populated, max 1024 chars
}

export interface MediaGroupOutgoingMessage extends BaseOutgoingMessage {
  type: 'media_group';
  items: MediaGroupItem[]; // 2 to 10 items
}

export type TelegramOutgoingMessage =
  | TextOutgoingMessage
  | SingleMediaOutgoingMessage
  | MediaGroupOutgoingMessage;

export interface TelegramPayload {
  postId: string;
  postVersion: number;
  messages: TelegramOutgoingMessage[];
  totalMessages: number;
  hasMedia: boolean;
  isMultiMessage: boolean;
}
```

---

## 6. Worker Execution Architecture & Partial Publication Resume (AGENTS.md §23, §48)

### 6.1 Partial Publishing Invariants
**Rule (AGENTS.md §23)**:
> "A logical post may require multiple Telegram API calls.  
> Example: `sendMediaGroup()` + `sendMessage()`.  
> If the first succeeds and the second fails, do not blindly restart everything.  
> Store Telegram message IDs after each successful step.  
> Retries should resume safely where technically possible.  
> Never duplicate already-published messages just because the final step failed."

### 6.2 Execution Flow & Idempotency Mapping
In PostgreSQL, `PublicationJob` stores:
- `idempotencyKey: "publish:{postId}:{version}"` (UNIQUE constraint)
- `telegramMessageIds: Json` (array of recorded Telegram message IDs, e.g. `[1001, 1002]`)

#### Worker Resume Execution Logic:
```text
Job Dequeued (publish:postId:version)
   ↓
Load Post, Template, Media from PostgreSQL
   ↓
TelegramRenderer.render(post, template, media) -> TelegramPayload
   ↓
Inspect job.telegramMessageIds from DB
   ↓
Loop through payload.messages by partIndex:
   Is partIndex already executed in DB?
   ├── YES: Skip sending (prevents duplicates!)
   └── NO:  Send via ITelegramPublisher
            ↓
            Receive Telegram message ID(s)
            ↓
            Append message IDs to job.telegramMessageIds in PostgreSQL (Durable Save)
   ↓
All parts completed -> PostStatus = PUBLISHED, JobStatus = COMPLETED
```

If transient network error (`ETIMEDOUT`, `504 Gateway Timeout`) occurs while sending Message 2:
1. Message 1's IDs (`[1001, 1002]`) are already committed to PostgreSQL.
2. BullMQ retries the job with exponential backoff.
3. On attempt 2, the worker checks `job.telegramMessageIds`:
   - Sees `media_group` was already sent.
   - Skips `sendMediaGroup()` call!
   - Immediately executes `sendMessage()` for Message 2.
4. Channel receives clean publication without duplicated media!

---

## 7. Concrete Implementation Plan for Milestone 3 Worker

### Step 1: Module Creation
Create `src/modules/rendering/`:
- `html-sanitizer.ts`: Contains `HtmlSanitizer` with unit tests for:
  - Allowed tags (`b, i, u, s, code, pre, a, blockquote`).
  - Safe href sanitization (`https://`, `http://`, `tg://`).
  - Automatic tag balancing and stack unwinding.
  - Dangerous tag stripping (`<script>`, `<iframe>`, inline handlers `onclick`).
  - Unsupported tag stripping (`<div>`, `<p>`, `<span>`, `<h1>`).
- `html-splitter.ts`: Tag-balanced splitting for 1024 captions and 4096 messages.
- `types/telegram-payload.types.ts`: Domain payload definitions.
- `telegram-renderer.service.ts`: Canonical rendering pipeline.
- `rendering.module.ts`: Exporting `TelegramRenderer` and `HtmlSanitizer`.

### Step 2: Templates & Media Integration
- Link `TelegramRenderer` with `TemplatesService` (`m3_explorer_1`) and `MediaService` (`m3_explorer_3`).
- Re-use `telegram_file_id` directly without local file download or re-upload.

### Step 3: Test Verification
- Add comprehensive unit tests in `tests/unit/rendering.spec.ts` and `tests/unit/html-sanitizer.spec.ts`.
- Verify existing E2E tests (`npm run test:e2e`) remain 100% passing.

---
*End of Report.*
