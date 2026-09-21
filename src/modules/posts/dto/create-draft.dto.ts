export class CreateDraftDto {
  authorId: string;
  channelId: string;
  templateId: string;
  templateVersion?: number;
  title?: string | null;
  contentJson?: Record<string, unknown>;
  metadataJson?: Record<string, unknown>;
}
