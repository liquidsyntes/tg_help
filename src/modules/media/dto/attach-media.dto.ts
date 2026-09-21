import { MediaType } from '@prisma/client';

export class AttachMediaDto {
  telegramFileId!: string;
  telegramFileUniqueId!: string;
  mediaType!: MediaType;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: bigint | number | null;
  caption?: string | null;
  sortOrder?: number;
}
