import { PostMedia } from '@prisma/client';

export interface EnrichedPostMedia extends PostMedia {
  isVideoDocument: boolean;
  isImageDocument: boolean;
  transportMethod: 'sendPhoto' | 'sendVideo' | 'sendDocument' | 'sendAnimation';
}
