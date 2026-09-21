import { Injectable } from '@nestjs/common';

@Injectable()
export class HtmlSanitizer {
  private static readonly ALLOWED_TAGS = new Set([
    'b',
    'strong',
    'i',
    'em',
    'u',
    'ins',
    's',
    'strike',
    'del',
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
   * Sanitizes raw HTML input to produce safe, valid Telegram HTML.
   * Strips dangerous scripts/handlers, restricts allowed tags and attributes,
   * escapes raw entity characters, and balances unclosed/misnested tags.
   */
  public sanitize(rawHtml: string): string {
    if (!rawHtml || typeof rawHtml !== 'string') {
      return '';
    }

    // 1. Strip script, style, iframe, object, embed along with inner contents
    let clean = rawHtml
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
      .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
      .replace(/<embed\b[^>]*>/gi, '')
      .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

    // Convert <br> or <br/> tags to newlines
    clean = clean.replace(/<br\s*\/?>/gi, '\n');

    // 2. Tokenize tags and text segments
    const tagRegex = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*?)?>/g;
    const tagStack: string[] = [];
    let lastIndex = 0;
    let result = '';
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(clean)) !== null) {
      const matchIndex = match.index;
      const fullTag = match[0];
      const rawTagName = (match[1] ?? '').toLowerCase();
      const isClosing = fullTag.startsWith('</');

      // Process text segment preceding the tag: escape raw &, <, >
      const textSegment = clean.slice(lastIndex, matchIndex);
      if (textSegment.length > 0) {
        result += this.escapeTextSegment(textSegment);
      }
      lastIndex = tagRegex.lastIndex;

      if (!rawTagName || !HtmlSanitizer.ALLOWED_TAGS.has(rawTagName)) {
        // Disallowed tag (e.g. <div>, <p>, <span>): strip tag itself, inner text preserved
        continue;
      }

      const canonicalTag = HtmlSanitizer.TAG_NORMALIZATION[rawTagName] ?? rawTagName;

      if (isClosing) {
        // Closing tag
        const top = tagStack[tagStack.length - 1];
        if (top === canonicalTag) {
          tagStack.pop();
          result += `</${canonicalTag}>`;
        } else if (tagStack.includes(canonicalTag)) {
          // Misnested closing tag: unwind stack until matching tag
          while (tagStack.length > 0) {
            const popped = tagStack.pop()!;
            result += `</${popped}>`;
            if (popped === canonicalTag) {
              break;
            }
          }
        }
        // If canonicalTag is not open in stack, ignore rogue closing tag
      } else {
        // Opening tag: sanitize attributes
        let sanitizedOpenTag = `<${canonicalTag}>`;

        if (canonicalTag === 'a') {
          const hrefMatch = fullTag.match(/href\s*=\s*["']([^"']*)["']/i);
          const href = hrefMatch && hrefMatch[1] ? hrefMatch[1].trim() : '';
          if (this.isValidHref(href)) {
            sanitizedOpenTag = `<a href="${this.escapeAttribute(href)}">`;
          } else {
            // Invalid or missing href: strip <a> tag, inner text will follow
            continue;
          }
        } else if (canonicalTag === 'pre' || canonicalTag === 'code') {
          const classMatch = fullTag.match(/class\s*=\s*["'](language-[a-zA-Z0-9_-]+)["']/i);
          if (classMatch && classMatch[1]) {
            sanitizedOpenTag = `<${canonicalTag} class="${classMatch[1]}">`;
          }
        }

        tagStack.push(canonicalTag);
        result += sanitizedOpenTag;
      }
    }

    // Process remaining trailing text
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
   * Escapes unescaped &, <, > without double-escaping valid existing entities.
   */
  public escapeTextSegment(text: string): string {
    return text
      .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Escapes all HTML special characters in plain text for interpolation.
   */
  public escapeText(plainText: string): string {
    if (!plainText) return '';
    return String(plainText)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Strips all HTML tags and returns plain text.
   */
  public stripAllTags(html: string): string {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '');
  }

  private isValidHref(href: string): boolean {
    if (!href) return false;
    const lower = href.toLowerCase();
    return (
      lower.startsWith('https://') ||
      lower.startsWith('http://') ||
      lower.startsWith('tg://')
    );
  }

  private escapeAttribute(attr: string): string {
    return attr
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
