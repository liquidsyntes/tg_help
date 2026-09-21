/**
 * HTML-aware text splitting engine for Telegram messages.
 * Authoritative reference: AGENTS.md § 16, § 18, tasks.md § 16
 */

export interface SplitResult {
  part1: string;
  part2?: string;
}

interface OpenTagInfo {
  tagName: string;
  fullOpenTag: string;
}

export class HtmlSplitter {
  /**
   * Splits an HTML string at or before maxLength, respecting tag boundaries
   * and auto-balancing active open tags across the split boundary.
   */
  public static splitHtml(html: string, maxLength: number): SplitResult {
    if (!html || html.length <= maxLength) {
      return { part1: html || '' };
    }

    // 1. Find optimal natural cut point <= maxLength
    const cutPoint = this.findOptimalCutPoint(html, maxLength);

    // 2. Track active open tags up to cutPoint
    const activeTags = this.getActiveOpenTags(html.slice(0, cutPoint));

    // 3. Close open tags at end of Part 1 (in reverse LIFO order)
    const closingSuffix = activeTags
      .slice()
      .reverse()
      .map((t) => `</${t.tagName}>`)
      .join('');
    const part1 = html.slice(0, cutPoint).trimEnd() + closingSuffix;

    // 4. Reopen active tags at start of Part 2
    const openingPrefix = activeTags.map((t) => t.fullOpenTag).join('');
    const remainder = openingPrefix + html.slice(cutPoint).trimStart();

    return {
      part1,
      part2: remainder,
    };
  }

  /**
   * Recursively splits HTML into an array of chunks, each strictly <= maxLength.
   */
  public static splitIntoChunks(html: string, maxLength = 4096): string[] {
    if (!html) return [];
    if (html.length <= maxLength) return [html];

    const chunks: string[] = [];
    let current = html;

    while (current.length > maxLength) {
      const { part1, part2 } = this.splitHtml(current, maxLength);
      chunks.push(part1);
      if (!part2 || part2 === current) {
        // Prevent infinite loop if string cannot be shortened further
        if (part2 && part2.length > maxLength) {
          chunks.push(part2.slice(0, maxLength));
          current = part2.slice(maxLength);
        } else {
          break;
        }
      } else {
        current = part2;
      }
    }

    if (current && current.length > 0) {
      chunks.push(current);
    }

    return chunks;
  }

  /**
   * Locates a natural splitting boundary (paragraph break, line break, sentence, word)
   * strictly before maxLength, ensuring we do not cut inside <tag> or &entity;.
   */
  private static findOptimalCutPoint(html: string, maxLength: number): number {
    let safeLimit = maxLength;

    // Safety check 1: ensure safeLimit does not fall inside an HTML tag (<...>)
    const lastOpenAngle = html.lastIndexOf('<', safeLimit);
    const lastCloseAngle = html.lastIndexOf('>', safeLimit);
    if (lastOpenAngle !== -1 && lastOpenAngle > lastCloseAngle) {
      safeLimit = lastOpenAngle;
    }

    // Safety check 2: ensure safeLimit does not fall inside an HTML entity (&...;)
    const lastAmp = html.lastIndexOf('&', safeLimit);
    const lastSemicolon = html.lastIndexOf(';', safeLimit);
    if (lastAmp !== -1 && lastAmp > lastSemicolon && safeLimit - lastAmp < 10) {
      safeLimit = lastAmp;
    }

    if (safeLimit <= 0) {
      safeLimit = maxLength;
    }

    // Search for natural break points within the last 30% of safeLimit
    const minAcceptable = Math.max(0, Math.floor(safeLimit * 0.7));
    const windowText = html.slice(minAcceptable, safeLimit);

    // 1. Paragraph break (\n\n)
    const paragraphBreak = windowText.lastIndexOf('\n\n');
    if (paragraphBreak !== -1) {
      return minAcceptable + paragraphBreak + 2;
    }

    // 2. Line break (\n)
    const lineBreak = windowText.lastIndexOf('\n');
    if (lineBreak !== -1) {
      return minAcceptable + lineBreak + 1;
    }

    // 3. Sentence end followed by whitespace (. / ! / ?)
    const sentenceMatch = /[.!?]\s+/g;
    let match: RegExpExecArray | null;
    let lastSentenceEnd = -1;
    while ((match = sentenceMatch.exec(windowText)) !== null) {
      lastSentenceEnd = match.index + match[0].length;
    }
    if (lastSentenceEnd !== -1) {
      return minAcceptable + lastSentenceEnd;
    }

    // 4. Space / word boundary
    const spaceIndex = windowText.lastIndexOf(' ');
    if (spaceIndex !== -1) {
      return minAcceptable + spaceIndex + 1;
    }

    // Fallback: strict safe limit
    return safeLimit;
  }

  /**
   * Tracks unclosed tags up to the split position.
   */
  private static getActiveOpenTags(fragment: string): OpenTagInfo[] {
    const tagRegex = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*?)?>/g;
    const stack: OpenTagInfo[] = [];
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(fragment)) !== null) {
      const fullTag = match[0];
      const rawTagName = (match[1] ?? '').toLowerCase();
      const isClosing = fullTag.startsWith('</');

      if (isClosing) {
        // Find matching tag in stack
        for (let i = stack.length - 1; i >= 0; i--) {
          const item = stack[i];
          if (item && item.tagName === rawTagName) {
            stack.splice(i, 1);
            break;
          }
        }
      } else if (!fullTag.endsWith('/>')) {
        stack.push({
          tagName: rawTagName,
          fullOpenTag: fullTag,
        });
      }
    }

    return stack;
  }
}
