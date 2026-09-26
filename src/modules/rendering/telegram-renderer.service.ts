import { Injectable } from '@nestjs/common';
import { Post, PostTemplate, PostMedia, MediaType } from '@prisma/client';
import { HtmlSanitizer } from './html-sanitizer.service';
import { HtmlSplitter } from './html-splitter';
import {
  TelegramPayload,
  TelegramOutgoingMessage,
  MediaGroupItem,
  OutgoingMessageType,
} from './interfaces/telegram-payload.interface';
import {
  TemplateSchema,
  TemplateRenderConfig,
} from '../templates/interfaces/template.interface';
import { TELEGRAM_LIMITS } from '../../common/constants/telegram-limits';
import { isDocumentAsVideo } from '../media/utils/media-detector.util';

@Injectable()
export class TelegramRenderer {
  constructor(private readonly sanitizer: HtmlSanitizer) {}

  /**
   * Canonical rendering pipeline for both Preview and Channel Publication.
   * Authoritative reference: AGENTS.md § 15, § 16, tasks.md § 15, § 16
   */
  public async render(
    post: Post,
    template: PostTemplate,
    media: PostMedia[] = [],
  ): Promise<TelegramPayload> {
    const renderedHtml = this.renderHtml(post, template);
    const sortedMedia = [...media].sort((a, b) => a.sortOrder - b.sortOrder);

    // Case 1: No media -> Pure text message(s)
    if (sortedMedia.length === 0) {
      if (renderedHtml.length <= TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH) {
        return {
          messages: [
            {
              partIndex: 0,
              type: 'text',
              text: renderedHtml,
              html: renderedHtml,
            },
          ],
        };
      }

      const chunks = HtmlSplitter.splitIntoChunks(
        renderedHtml,
        TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH,
      );
      return {
        messages: chunks.map((chunk, idx) => ({
          partIndex: idx,
          type: 'text',
          text: chunk,
          html: chunk,
        })),
      };
    }

    // Case 2: Single media item
    if (sortedMedia.length === 1) {
      const item = sortedMedia[0]!;
      const outgoingType = this.resolveOutgoingMediaType(item);

      if (renderedHtml.length <= TELEGRAM_LIMITS.MAX_CAPTION_LENGTH) {
        return {
          messages: [
            {
              partIndex: 0,
              type: outgoingType,
              fileId: item.telegramFileId,
              caption: renderedHtml,
              fileName: item.fileName ?? undefined,
              mimeType: item.mimeType ?? undefined,
            },
          ],
        };
      }

      // Rendered HTML exceeds caption limit (1024) -> Multi-message split!
      // Message 1: media with caption <= 1024
      // Message 2..N: remaining text <= 4096
      const { part1, part2 } = HtmlSplitter.splitHtml(
        renderedHtml,
        TELEGRAM_LIMITS.MAX_CAPTION_LENGTH,
      );

      const messages: TelegramOutgoingMessage[] = [
        {
          partIndex: 0,
          type: outgoingType,
          fileId: item.telegramFileId,
          caption: part1,
          fileName: item.fileName ?? undefined,
          mimeType: item.mimeType ?? undefined,
        },
      ];

      if (part2 && part2.trim().length > 0) {
        const textChunks = HtmlSplitter.splitIntoChunks(
          part2,
          TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH,
        );
        textChunks.forEach((chunk) => {
          messages.push({
            partIndex: messages.length,
            type: 'text',
            text: chunk,
            html: chunk,
          });
        });
      }

      return { messages };
    }

    // Case 3: Media Group (2-10 items)
    const items: MediaGroupItem[] = sortedMedia.map((item) => {
      let groupType: 'photo' | 'video' | 'document' = 'photo';
      if (item.mediaType === MediaType.VIDEO) {
        groupType = 'video';
      } else if (item.mediaType === MediaType.DOCUMENT) {
        groupType = 'document';
      }
      return {
        type: groupType,
        fileId: item.telegramFileId,
      };
    });

    if (renderedHtml.length <= TELEGRAM_LIMITS.MAX_CAPTION_LENGTH) {
      if (items[0]) {
        items[0].caption = renderedHtml;
      }
      return {
        messages: [
          {
            partIndex: 0,
            type: 'media_group',
            items,
          },
        ],
      };
    }

    // Rendered HTML exceeds caption limit -> Multi-message split!
    // Message 1: media_group with lead item caption <= 1024
    // Message 2..N: remaining text <= 4096
    const { part1, part2 } = HtmlSplitter.splitHtml(
      renderedHtml,
      TELEGRAM_LIMITS.MAX_CAPTION_LENGTH,
    );
    if (items[0]) {
      items[0].caption = part1;
    }

    const messages: TelegramOutgoingMessage[] = [
      {
        partIndex: 0,
        type: 'media_group',
        items,
      },
    ];

    if (part2 && part2.trim().length > 0) {
      const textChunks = HtmlSplitter.splitIntoChunks(
        part2,
        TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH,
      );
      textChunks.forEach((chunk) => {
        messages.push({
          partIndex: messages.length,
          type: 'text',
          text: chunk,
          html: chunk,
        });
      });
    }

    return { messages };
  }

  /**
   * Canonical text formatting pipeline interpolating Post content into Template layout.
   */
  public renderHtml(post: Post, template: PostTemplate): string {
    const content = (post.contentJson as Record<string, unknown>) || {};
    const schema = template.schemaJson as unknown as TemplateSchema;
    const renderConfig = template.renderConfig as unknown as TemplateRenderConfig;
    const layout = renderConfig?.layout || '';

    // Field dictionary for placeholder replacement
    const replacements: Record<string, string> = {};

    for (const field of schema?.fields || []) {
      const rawVal = content[field.key];
      if (rawVal === undefined || rawVal === null) {
        replacements[field.key] = '';
      } else if (field.type === 'rich_text') {
        replacements[field.key] = this.sanitizer.sanitize(String(rawVal));
      } else {
        replacements[field.key] = this.sanitizer.escapeText(String(rawVal));
      }
    }

    // Format tags if present
    const rawTags = content.tags ?? (post as unknown as { tags?: unknown }).tags;
    if (Array.isArray(rawTags) && rawTags.length > 0) {
      replacements['tags'] = rawTags
        .map((t) => (String(t).startsWith('#') ? String(t) : `#${String(t)}`))
        .join(' ');
    } else if (typeof rawTags === 'string' && rawTags.trim().length > 0) {
      replacements['tags'] = this.sanitizer.escapeText(rawTags.trim());
    } else {
      replacements['tags'] = '';
    }

    // Format CTA if present
    const rawCta = content.cta ?? (post as unknown as { cta?: unknown }).cta;
    if (rawCta && typeof rawCta === 'string' && rawCta.trim().length > 0) {
      replacements['cta'] = this.sanitizer.escapeText(rawCta.trim());
    } else {
      replacements['cta'] = '';
    }

    // Author variables
    const author = (post as any).author;
    if (author) {
      const authorName = [author.firstName, author.lastName].filter(Boolean).join(' ') || author.username || `ID ${author.telegramId}`;
      replacements['author_name'] = this.sanitizer.escapeText(authorName);
      
      if (author.username) {
        replacements['author_mention'] = `@${this.sanitizer.escapeText(author.username)}`;
        replacements['author_link'] = `https://t.me/${author.username}`;
      } else {
        replacements['author_mention'] = `<a href="tg://user?id=${author.telegramId}">${this.sanitizer.escapeText(authorName)}</a>`;
        replacements['author_link'] = `tg://user?id=${author.telegramId}`;
      }
    } else {
      replacements['author_name'] = '';
      replacements['author_mention'] = '';
      replacements['author_link'] = '';
    }

    // Interpolate layout: replace {{key}} tokens
    let text = layout.replace(
      /\{\{([a-zA-Z0-9_]+)\}\}/g,
      (_match, key) => replacements[key] ?? '',
    );

    // Clean up empty tags left by omitted optional fields (e.g. <i></i>, <b></b>)
    text = text.replace(/<(b|i|u|s|blockquote|code|pre)>\s*<\/\1>/gi, '');

    // Collapse excessive blank lines
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    // Final safety pass
    return this.sanitizer.sanitize(text);
  }

  private resolveOutgoingMediaType(media: PostMedia): OutgoingMessageType {
    if (media.mediaType === MediaType.PHOTO) {
      return 'photo';
    }
    if (media.mediaType === MediaType.VIDEO) {
      return 'video';
    }
    if (media.mediaType === MediaType.ANIMATION) {
      return 'animation';
    }
    if (media.mediaType === MediaType.DOCUMENT) {
      return 'document';
    }
    return 'document';
  }
}
