import { Injectable } from '@nestjs/common';
import {
  TemplateFieldDefinition,
  TemplateFieldType,
  TemplateSchema,
  TemplateRenderConfig,
  FieldValidationError,
  ValidationResult,
} from './interfaces/template.interface';
import { InvalidTemplateException } from '../../common/exceptions/domain.exceptions';

@Injectable()
export class TemplateValidator {
  private static readonly ALLOWED_FIELD_TYPES = new Set<TemplateFieldType>([
    'text',
    'textarea',
    'rich_text',
    'number',
    'url',
  ]);

  /**
   * Coerces raw Telegram user string input to the field's target type if needed.
   * Returns coerced value and any coercion errors.
   */
  public coerceFieldValue(
    fieldDef: TemplateFieldDefinition,
    rawValue: unknown,
  ): { value: unknown; error?: FieldValidationError } {
    if (rawValue === undefined || rawValue === null) {
      return { value: rawValue };
    }

    if (fieldDef.type === 'number') {
      if (typeof rawValue === 'number') {
        if (Number.isNaN(rawValue)) {
          return {
            value: rawValue,
            error: {
              field: fieldDef.key,
              label: fieldDef.label,
              code: 'INVALID_NUMBER',
              message: `Поле «${fieldDef.label}» должно быть числом.`,
            },
          };
        }
        return { value: rawValue };
      }

      if (typeof rawValue === 'string') {
        const trimmed = rawValue.trim();
        if (trimmed === '') {
          return { value: null };
        }
        // Replace comma with period for standard localized decimal input
        const normalized = trimmed.replace(',', '.');
        const parsed = Number(normalized);
        if (Number.isNaN(parsed)) {
          return {
            value: rawValue,
            error: {
              field: fieldDef.key,
              label: fieldDef.label,
              code: 'INVALID_NUMBER',
              message: `Поле «${fieldDef.label}» должно быть числом.`,
            },
          };
        }
        return { value: parsed };
      }

      return {
        value: rawValue,
        error: {
          field: fieldDef.key,
          label: fieldDef.label,
          code: 'INVALID_NUMBER',
          message: `Поле «${fieldDef.label}» должно быть числом.`,
        },
      };
    }

    if (typeof rawValue === 'string') {
      return { value: rawValue.trim() };
    }

    return { value: rawValue };
  }

  /**
   * Validates a single field value against its definition.
   */
  public validateField(
    fieldDef: TemplateFieldDefinition,
    rawValue: unknown,
  ): FieldValidationError | null {
    const { value, error: coercionError } = this.coerceFieldValue(fieldDef, rawValue);
    if (coercionError) {
      return coercionError;
    }

    const isNullOrUndefined = value === undefined || value === null;
    const isString = typeof value === 'string';
    const isEmptyString = isString && value.trim().length === 0;

    // 1. Required constraint
    if (fieldDef.required) {
      if (isNullOrUndefined || isEmptyString) {
        return {
          field: fieldDef.key,
          label: fieldDef.label,
          code: 'REQUIRED',
          message: `Поле «${fieldDef.label}» обязательно для заполнения.`,
        };
      }
    } else {
      // Optional field and empty: bypass remaining checks
      if (isNullOrUndefined || isEmptyString) {
        return null;
      }
    }

    // 2. Type-specific validations
    if (
      fieldDef.type === 'text' ||
      fieldDef.type === 'textarea' ||
      fieldDef.type === 'rich_text' ||
      fieldDef.type === 'url'
    ) {
      if (!isString) {
        return {
          field: fieldDef.key,
          label: fieldDef.label,
          code: 'INVALID_STRING',
          message: `Поле «${fieldDef.label}» должно быть текстовой строкой.`,
        };
      }

      const strVal = value as string;

      if (fieldDef.minLength !== undefined && strVal.length < fieldDef.minLength) {
        return {
          field: fieldDef.key,
          label: fieldDef.label,
          code: 'MIN_LENGTH',
          message: `Поле «${fieldDef.label}» слишком короткое: минимум ${fieldDef.minLength} симв. (сейчас: ${strVal.length}).`,
        };
      }

      if (fieldDef.maxLength !== undefined && strVal.length > fieldDef.maxLength) {
        return {
          field: fieldDef.key,
          label: fieldDef.label,
          code: 'MAX_LENGTH',
          message: `Поле «${fieldDef.label}» превышает допустимый лимит (${strVal.length}/${fieldDef.maxLength} симв.). Пожалуйста, сократите текст.`,
        };
      }

      if (fieldDef.type === 'url') {
        const trimmed = strVal.trim();
        const lower = trimmed.toLowerCase();
        if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
          return {
            field: fieldDef.key,
            label: fieldDef.label,
            code: 'INVALID_URL',
            message: `Поле «${fieldDef.label}» должно содержать корректную ссылку, начинающуюся с https:// или http://.`,
          };
        }
        try {
          new URL(trimmed);
        } catch {
          return {
            field: fieldDef.key,
            label: fieldDef.label,
            code: 'INVALID_URL',
            message: `Поле «${fieldDef.label}» должно содержать корректную ссылку, начинающуюся с https:// или http://.`,
          };
        }
      }

      if (fieldDef.regex) {
        try {
          const re = new RegExp(fieldDef.regex);
          if (!re.test(strVal)) {
            return {
              field: fieldDef.key,
              label: fieldDef.label,
              code: 'PATTERN_MISMATCH',
              message:
                fieldDef.regexMessage ||
                `Значение поля «${fieldDef.label}» не соответствует требуемому формату.`,
            };
          }
        } catch {
          // If regex is invalid, we don't throw during runtime validation, but flag
        }
      }
    } else if (fieldDef.type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return {
          field: fieldDef.key,
          label: fieldDef.label,
          code: 'INVALID_NUMBER',
          message: `Поле «${fieldDef.label}» должно быть числом.`,
        };
      }

      if (fieldDef.integer && !Number.isInteger(value)) {
        return {
          field: fieldDef.key,
          label: fieldDef.label,
          code: 'NOT_INTEGER',
          message: `Поле «${fieldDef.label}» должно быть целым числом.`,
        };
      }

      if (fieldDef.min !== undefined && value < fieldDef.min) {
        return {
          field: fieldDef.key,
          label: fieldDef.label,
          code: 'MIN_VALUE',
          message: `Значение поля «${fieldDef.label}» не может быть меньше ${fieldDef.min} (получено: ${value}).`,
        };
      }

      if (fieldDef.max !== undefined && value > fieldDef.max) {
        return {
          field: fieldDef.key,
          label: fieldDef.label,
          code: 'MAX_VALUE',
          message: `Значение поля «${fieldDef.label}» не может быть больше ${fieldDef.max} (получено: ${value}).`,
        };
      }
    }

    return null;
  }

  /**
   * Validates full post content against a template schema.
   */
  public validateContent(
    schema: TemplateSchema,
    content: Record<string, unknown>,
    options: { allowPartial?: boolean } = {},
  ): ValidationResult {
    const errors: FieldValidationError[] = [];
    const fields = schema?.fields || [];
    const allowPartial = options.allowPartial ?? false;

    for (const field of fields) {
      const rawValue = content[field.key];
      const isOmitted = rawValue === undefined || rawValue === null;

      if (isOmitted && allowPartial) {
        // Skip omitted fields when partial validation is allowed
        continue;
      }

      const error = this.validateField(field, rawValue);
      if (error) {
        errors.push(error);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validates template schema definition and render configuration.
   * Throws InvalidTemplateException if invalid.
   */
  public validateTemplateSchema(schema: unknown, renderConfig?: unknown): void {
    if (!schema || typeof schema !== 'object') {
      throw new InvalidTemplateException('Template schemaJson must be an object.');
    }

    const tplSchema = schema as TemplateSchema;
    if (!Array.isArray(tplSchema.fields) || tplSchema.fields.length === 0) {
      throw new InvalidTemplateException('Template schemaJson must contain a non-empty "fields" array.');
    }

    const seenKeys = new Set<string>();
    const keyRegex = /^[a-z0-9_]{1,64}$/;

    for (const field of tplSchema.fields) {
      if (!field.key || typeof field.key !== 'string' || !keyRegex.test(field.key)) {
        throw new InvalidTemplateException(
          `Field key "${field.key}" is invalid. Must match regex /^[a-z0-9_]{1,64}$/.`,
        );
      }

      if (seenKeys.has(field.key)) {
        throw new InvalidTemplateException(`Duplicate field key "${field.key}" in template schema.`);
      }
      seenKeys.add(field.key);

      if (!field.label || typeof field.label !== 'string') {
        throw new InvalidTemplateException(`Field "${field.key}" must have a non-empty label.`);
      }

      if (!TemplateValidator.ALLOWED_FIELD_TYPES.has(field.type)) {
        throw new InvalidTemplateException(
          `Field "${field.key}" has unsupported type "${field.type}". Allowed: ${Array.from(
            TemplateValidator.ALLOWED_FIELD_TYPES,
          ).join(', ')}.`,
        );
      }

      if (field.minLength !== undefined && (field.minLength < 0 || !Number.isInteger(field.minLength))) {
        throw new InvalidTemplateException(`Field "${field.key}" minLength must be a non-negative integer.`);
      }

      if (field.maxLength !== undefined && (field.maxLength < 0 || !Number.isInteger(field.maxLength))) {
        throw new InvalidTemplateException(`Field "${field.key}" maxLength must be a non-negative integer.`);
      }

      if (
        field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.maxLength < field.minLength
      ) {
        throw new InvalidTemplateException(
          `Field "${field.key}" maxLength (${field.maxLength}) cannot be less than minLength (${field.minLength}).`,
        );
      }

      if (field.min !== undefined && field.max !== undefined && field.max < field.min) {
        throw new InvalidTemplateException(
          `Field "${field.key}" max (${field.max}) cannot be less than min (${field.min}).`,
        );
      }

      if (field.regex) {
        try {
          new RegExp(field.regex);
        } catch {
          throw new InvalidTemplateException(`Field "${field.key}" regex is invalid.`);
        }
      }
    }

    if (renderConfig !== undefined && renderConfig !== null) {
      if (typeof renderConfig !== 'object') {
        throw new InvalidTemplateException('Template renderConfig must be an object.');
      }
      const config = renderConfig as TemplateRenderConfig;
      if (!config.layout || typeof config.layout !== 'string' || config.layout.trim().length === 0) {
        throw new InvalidTemplateException('Template renderConfig must have a non-empty "layout" string.');
      }
    }
  }
}
