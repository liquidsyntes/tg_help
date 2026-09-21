import { TemplateSchema, TemplateRenderConfig } from '../interfaces/template.interface';

export class UpdateTemplateDto {
  name?: string;
  description?: string | null;
  schemaJson?: TemplateSchema;
  renderConfig?: TemplateRenderConfig;
  supportedMediaTypes?: string[];
  isActive?: boolean;
}
