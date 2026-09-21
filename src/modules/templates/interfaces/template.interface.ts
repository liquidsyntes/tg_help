/**
 * Template domain interfaces and types.
 * Authoritative reference: AGENTS.md § 14, tasks.md § 9, § 14
 */

export type TemplateFieldType = 'text' | 'textarea' | 'rich_text' | 'number' | 'url';

export interface TemplateFieldDefinition {
  key: string;
  label: string;
  type: TemplateFieldType;
  required: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  regex?: string;
  regexMessage?: string;
  hint?: string;
  defaultValue?: unknown;
}

export interface TemplateSchema {
  fields: TemplateFieldDefinition[];
}

export interface TemplateRenderConfig {
  layout: string;
  headerTag?: string;
  tagsPrefix?: string;
  [key: string]: unknown;
}

export interface FieldValidationError {
  field: string;
  label: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: FieldValidationError[];
}
