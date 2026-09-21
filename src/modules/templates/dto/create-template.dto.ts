import { TemplateSchema, TemplateRenderConfig } from '../interfaces/template.interface';

export class CreateTemplateDto {
  key!: string;
  name!: string;
  description?: string | null;
  schemaJson!: TemplateSchema;
  renderConfig!: TemplateRenderConfig;
  supportedMediaTypes!: string[];
  isActive?: boolean;
}
