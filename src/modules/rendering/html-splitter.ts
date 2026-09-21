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

    let safeLimit = maxLength;
    let cutPoint = this.findOptimalCutPoint(html, safeLimit);
    let activeTags = this.getActiveOpenTags(html.slice(0, cutPoint));
    let closingSuffix = activeTags
      .slice()
      .reverse()
      .map((t) => `</${t.tagName}>`)
      .join('');

    // Tag-aware length budgeting:
    // If cutPoint + closingSuffix.length > maxLength, reduce safeLimit by closing suffix length
    // and iterate until part1 (including closingSuffix) strictly respects maxLength under all tag nesting depths.
    let attempts = 0;
    while (
      html.slice(0, cutPoint).trimEnd().length + closingSuffix.length > maxLength &&
      safeLimit > 0 &&
      attempts < 20
    ) {
      attempts++;
      safeLimit = maxLength - closingSuffix.length;
      if (safeLimit <= 0) {
        break;
      }
      cutPoint = this.findOptimalCutPoint(html, safeLimit);
      activeTags = this.getActiveOpenTags(html.slice(0, cutPoint));
      closingSuffix = activeTags
        .slice()
        .reverse()
        .map((t) => `</${t.tagName}>`)
        .join('');
    }

    let part1 = html.slice(0, cutPoint).trimEnd() + closingSuffix;

    // Hard ceiling guarantee for pathological boundary conditions
    if (part1.length > maxLength) {
      if (closingSuffix.length < maxLength) {
        cutPoint = Math.max(0, maxLength - closingSuffix.length);
        activeTags = this.getActiveOpenTags(html.slice(0, cutPoint));
        closingSuffix = activeTags
          .slice()
          .reverse()
          .map((t) => `</${t.tagName}>`)
          .join('');
        part1 =
          html.slice(0, Math.max(0, maxLength - closingSuffix.length)).trimEnd() +
          closingSuffix;
      } else {
        part1 = html.slice(0, maxLength);
        cutPoint = maxLength;
        activeTags = [];
      }
    }

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
   * Checks if a cut position lands inside an HTML tag or HTML entity.
   */
  private static isInsideTagOrEntity(html: string, pos: number): boolean {
    if (pos <= 0 || pos >= html.length) {
      return false;
    }
    const frag = html.slice(0, pos);
    const lastOpenAngle = frag.lastIndexOf('<');
    const lastCloseAngle = frag.lastIndexOf('>');
    if (lastOpenAngle !== -1 && lastOpenAngle > lastCloseAngle) {
      return true;
    }
    const lastAmp = frag.lastIndexOf('&');
    const lastSemi = frag.lastIndexOf(';');
    if (lastAmp !== -1 && lastAmp > lastSemi && pos - lastAmp < 10) {
      return true;
    }
    return false;
  }

  /**
   * Locates a natural splitting boundary (paragraph break, line break, sentence, word)
   * strictly before maxLength, ensuring we do not cut inside <tag> or &entity;.
   */
  private static findOptimalCutPoint(html: string, maxLength: number): number {
    let safeLimit = maxLength;

    // Safety check 1: ensure safeLimit does not fall inside an HTML tag (<...>)
    const fragment = html.slice(0, safeLimit);
    const lastOpenAngle = fragment.lastIndexOf('<');
    const lastCloseAngle = fragment.lastIndexOf('>');
    if (lastOpenAngle !== -1 && lastOpenAngle > lastCloseAngle) {
      safeLimit = lastOpenAngle;
    }

    // Safety check 2: ensure safeLimit does not fall inside an HTML entity (&...;)
    const safeFrag = html.slice(0, safeLimit);
    const lastAmp = safeFrag.lastIndexOf('&');
    const lastSemicolon = safeFrag.lastIndexOf(';');
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
      const candidate = minAcceptable + paragraphBreak + 2;
      if (!this.isInsideTagOrEntity(html, candidate)) {
        return candidate;
      }
    }

    // 2. Line break (\n)
    const lineBreak = windowText.lastIndexOf('\n');
    if (lineBreak !== -1) {
      const candidate = minAcceptable + lineBreak + 1;
      if (!this.isInsideTagOrEntity(html, candidate)) {
        return candidate;
      }
    }

    // 3. Sentence end followed by whitespace (. / ! / ?)
    const sentenceMatch = /[.!?]\s+/g;
    let match: RegExpExecArray | null;
    let lastSentenceEnd = -1;
    while ((match = sentenceMatch.exec(windowText)) !== null) {
      const candidate = minAcceptable + match.index + match[0].length;
      if (!this.isInsideTagOrEntity(html, candidate)) {
        lastSentenceEnd = candidate;
      }
    }
    if (lastSentenceEnd !== -1) {
      return lastSentenceEnd;
    }

    // 4. Space / word boundary
    let searchPos = windowText.length;
    while (searchPos > 0) {
      const spaceIndex = windowText.lastIndexOf(' ', searchPos - 1);
      if (spaceIndex === -1) break;
      const candidate = minAcceptable + spaceIndex + 1;
      if (!this.isInsideTagOrEntity(html, candidate)) {
        return candidate;
      }
      searchPos = spaceIndex;
    }

    // Fallback: strict safe limit
    return safeLimit;
  }

  /**
   * Tracks unclosed tags up to the split position.
   */
  private static getActiveOpenTags(fragment: string): OpenTagInfo[] {
    const tagRegex = /<\/?([a-zA-Z0-9\-]+)(?:\s+[^>]*?)?>/g;
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
