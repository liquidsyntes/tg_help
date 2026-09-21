export class CreateChannelDto {
  telegramChatId: string;
  title: string;
  username?: string | null;
  timezone?: string;
  publicationMode?: string;
  isActive?: boolean;
}
