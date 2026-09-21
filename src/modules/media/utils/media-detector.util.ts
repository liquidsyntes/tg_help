import { MediaType } from '@prisma/client';

export const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime', // .mov
  'video/x-matroska', // .mkv
  'video/webm',
  'video/avi',
  'video/x-msvideo',
  'video/mpeg',
  'video/ogg',
  'video/3gpp',
  'video/3gpp2',
]);

export const VIDEO_FILE_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'm4v',
  'mpg',
  'mpeg',
]);

export function isDocumentAsVideo(media: {
  mediaType: MediaType | string;
  mimeType?: string | null;
  fileName?: string | null;
}): boolean {
  if (media.mediaType !== MediaType.DOCUMENT && media.mediaType !== 'DOCUMENT') {
    return false;
  }
  if (media.mimeType) {
    const mime = media.mimeType.toLowerCase();
    if (VIDEO_MIME_TYPES.has(mime) || mime.startsWith('video/')) {
      return true;
    }
  }
  if (media.fileName) {
    const ext = media.fileName.split('.').pop()?.toLowerCase();
    if (ext && VIDEO_FILE_EXTENSIONS.has(ext)) {
      return true;
    }
  }
  return false;
}

export interface MediaGroupValidationResult {
  isValid: boolean;
  isAlbum: boolean;
  error?: string;
}

export function validateMediaGroupCompatibility(
  items: Array<{ mediaType: MediaType | string }>,
): MediaGroupValidationResult {
  if (items.length <= 1) {
    return { isValid: true, isAlbum: false };
  }

  if (items.length > 10) {
    return {
      isValid: false,
      isAlbum: true,
      error: 'Медиагруппа не может содержать более 10 элементов (лимит Telegram).',
    };
  }

  const hasAnimation = items.some(
    (i) => i.mediaType === MediaType.ANIMATION || i.mediaType === 'ANIMATION',
  );
  if (hasAnimation) {
    return {
      isValid: false,
      isAlbum: true,
      error: 'GIF-анимации нельзя объединять в медиагруппу. Анимация отправляется отдельным сообщением.',
    };
  }

  const hasPhotoOrVideo = items.some(
    (i) =>
      i.mediaType === MediaType.PHOTO ||
      i.mediaType === 'PHOTO' ||
      i.mediaType === MediaType.VIDEO ||
      i.mediaType === 'VIDEO',
  );
  const hasDocument = items.some(
    (i) => i.mediaType === MediaType.DOCUMENT || i.mediaType === 'DOCUMENT',
  );

  if (hasPhotoOrVideo && hasDocument) {
    return {
      isValid: false,
      isAlbum: true,
      error: 'Нельзя объединять фото/видео и документы (файлы) в одну медиагруппу Telegram.',
    };
  }

  return { isValid: true, isAlbum: true };
}
