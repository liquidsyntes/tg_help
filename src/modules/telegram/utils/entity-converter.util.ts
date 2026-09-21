/**
 * Entity Converter Utility
 * Converts Telegram MessageEntity offsets to Telegram HTML tags.
 * Authoritative reference: AGENTS.md § 17; tasks.md § 17
 */

import { MessageEntity } from 'grammy/types';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function entitiesToHtml(text: string, entities?: MessageEntity[]): string {
  if (!text) return '';
  if (!entities || entities.length === 0) {
    return text;
  }

  // Sort entities by offset asc, length desc
  const sortedEntities = [...entities].sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    return b.length - a.length;
  });

  // Track insertion points: array of insertions at utf-16 offsets
  type TagInsertion = { offset: number; tag: string; isClosing: boolean; priority: number };
  const insertions: TagInsertion[] = [];

  for (const entity of sortedEntities) {
    const start = entity.offset;
    const end = entity.offset + entity.length;

    let openTag = '';
    let closeTag = '';

    switch (entity.type) {
      case 'bold':
        openTag = '<b>';
        closeTag = '</b>';
        break;
      case 'italic':
        openTag = '<i>';
        closeTag = '</i>';
        break;
      case 'underline':
        openTag = '<u>';
        closeTag = '</u>';
        break;
      case 'strikethrough':
        openTag = '<s>';
        closeTag = '</s>';
        break;
      case 'code':
        openTag = '<code>';
        closeTag = '</code>';
        break;
      case 'pre':
        if (entity.language) {
          openTag = `<pre><code class="language-${escapeHtml(entity.language)}">`;
          closeTag = '</code></pre>';
        } else {
          openTag = '<pre>';
          closeTag = '</pre>';
        }
        break;
      case 'text_link':
        if (entity.url) {
          openTag = `<a href="${escapeHtml(entity.url)}">`;
          closeTag = '</a>';
        }
        break;
      case 'blockquote':
        openTag = '<blockquote>';
        closeTag = '</blockquote>';
        break;
      case 'expandable_blockquote':
        openTag = '<blockquote expandable>';
        closeTag = '</blockquote>';
        break;
      case 'spoiler':
        openTag = '<tg-spoiler>';
        closeTag = '</tg-spoiler>';
        break;
      default:
        break;
    }

    if (openTag && closeTag) {
      insertions.push({ offset: start, tag: openTag, isClosing: false, priority: end });
      insertions.push({ offset: end, tag: closeTag, isClosing: true, priority: start });
    }
  }

  // Sort insertions:
  // At same offset: closing tags before opening tags; for closing tags, later open comes first.
  insertions.sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    if (a.isClosing && !b.isClosing) return -1;
    if (!a.isClosing && b.isClosing) return 1;
    if (a.isClosing) return b.priority - a.priority; // LIFO for closing
    return b.priority - a.priority; // longer range first for opening
  });

  let result = '';
  let currentOffset = 0;

  for (const ins of insertions) {
    if (ins.offset > currentOffset) {
      result += escapeHtml(text.slice(currentOffset, ins.offset));
      currentOffset = ins.offset;
    }
    result += ins.tag;
  }

  if (currentOffset < text.length) {
    result += escapeHtml(text.slice(currentOffset));
  }

  return result;
}
