import 'reflect-metadata';
import { TemplateValidator } from '../../src/modules/templates/template.validator';
import { TemplatesService } from '../../src/modules/templates/templates.service';
import {
  TemplateSchema,
  TemplateFieldDefinition,
} from '../../src/modules/templates/interfaces/template.interface';
import { SystemPermission, AuditAction } from '../../src/common/enums';
import {
  TemplateNotFoundException,
  InvalidTemplateException,
  ValidationException,
  PermissionDeniedException,
} from '../../src/common/exceptions/domain.exceptions';

describe('Templates Module Unit Tests', () => {
  let validator: TemplateValidator;
  let service: TemplatesService;
  let mockPrisma: any;
  let mockAuditService: any;
  let mockPermissionService: any;

  beforeEach(() => {
    validator = new TemplateValidator();
    mockPrisma = {
      postTemplate: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      post: {
        count: jest.fn(),
      },
    };
    mockAuditService = {
      record: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    };
    mockPermissionService = {
      enforceSystemPermission: jest.fn(),
    };

    service = new TemplatesService(
      mockPrisma as any,
      validator,
      mockAuditService as any,
      mockPermissionService as any,
    );
  });

  describe('TemplateValidator', () => {
    describe('Field Coercion (coerceFieldValue)', () => {
      it('should coerce string numbers to numeric values', () => {
        const field: TemplateFieldDefinition = {
          key: 'count',
          label: 'Количество',
          type: 'number',
          required: true,
        };
        expect(validator.coerceFieldValue(field, '42')).toEqual({ value: 42 });
        expect(validator.coerceFieldValue(field, ' 100 ')).toEqual({ value: 100 });
        expect(validator.coerceFieldValue(field, '3,14')).toEqual({ value: 3.14 });
      });

      it('should return Russian error for unparseable number strings', () => {
        const field: TemplateFieldDefinition = {
          key: 'count',
          label: 'Количество',
          type: 'number',
          required: true,
        };
        const result = validator.coerceFieldValue(field, 'not-a-number');
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe('INVALID_NUMBER');
        expect(result.error?.message).toBe('Поле «Количество» должно быть числом.');
      });

      it('should trim string values', () => {
        const field: TemplateFieldDefinition = {
          key: 'title',
          label: 'Заголовок',
          type: 'text',
          required: true,
        };
        expect(validator.coerceFieldValue(field, '  hello world  ')).toEqual({
          value: 'hello world',
        });
      });
    });

    describe('Field Constraints & Validations', () => {
      it('should validate required fields', () => {
        const field: TemplateFieldDefinition = {
          key: 'title',
          label: 'Заголовок',
          type: 'text',
          required: true,
        };
        expect(validator.validateField(field, '')?.code).toBe('REQUIRED');
        expect(validator.validateField(field, '   ')?.code).toBe('REQUIRED');
        expect(validator.validateField(field, null)?.code).toBe('REQUIRED');
        expect(validator.validateField(field, 'Valid Title')).toBeNull();
      });

      it('should skip non-required empty fields', () => {
        const field: TemplateFieldDefinition = {
          key: 'lead',
          label: 'Лид',
          type: 'text',
          required: false,
          minLength: 10,
        };
        expect(validator.validateField(field, '')).toBeNull();
        expect(validator.validateField(field, null)).toBeNull();
        expect(validator.validateField(field, undefined)).toBeNull();
      });

      it('should enforce minLength and maxLength with empathetic Russian messages', () => {
        const field: TemplateFieldDefinition = {
          key: 'summary',
          label: 'Краткое описание',
          type: 'text',
          required: true,
          minLength: 5,
          maxLength: 10,
        };
        const shortErr = validator.validateField(field, 'Hi');
        expect(shortErr?.code).toBe('MIN_LENGTH');
        expect(shortErr?.message).toContain('слишком короткое: минимум 5 симв.');

        const longErr = validator.validateField(field, 'More than ten characters');
        expect(longErr?.code).toBe('MAX_LENGTH');
        expect(longErr?.message).toContain('превышает допустимый лимит');

        expect(validator.validateField(field, 'Valid 123')).toBeNull();
      });

      it('should enforce number constraints (min, max, integer)', () => {
        const field: TemplateFieldDefinition = {
          key: 'score',
          label: 'Баллы',
          type: 'number',
          required: true,
          min: 1,
          max: 10,
          integer: true,
        };
        expect(validator.validateField(field, 0)?.code).toBe('MIN_VALUE');
        expect(validator.validateField(field, 11)?.code).toBe('MAX_VALUE');
        expect(validator.validateField(field, 5.5)?.code).toBe('NOT_INTEGER');
        expect(validator.validateField(field, 5)).toBeNull();
      });

      it('should validate URL fields', () => {
        const field: TemplateFieldDefinition = {
          key: 'link',
          label: 'Ссылка',
          type: 'url',
          required: true,
        };
        expect(validator.validateField(field, 'ftp://example.com')?.code).toBe('INVALID_URL');
        expect(validator.validateField(field, 'not-a-url')?.code).toBe('INVALID_URL');
        expect(validator.validateField(field, 'https://tghelp.org')).toBeNull();
        expect(validator.validateField(field, 'http://localhost:3000')).toBeNull();
      });

      it('should validate regex patterns and custom regexMessage', () => {
        const field: TemplateFieldDefinition = {
          key: 'channelHandle',
          label: 'Юзернейм',
          type: 'text',
          required: true,
          regex: '^@[a-zA-Z0-9_]+$',
          regexMessage: 'Юзернейм должен начинаться с символа @',
        };
        const err = validator.validateField(field, 'invalid_handle');
        expect(err?.code).toBe('PATTERN_MISMATCH');
        expect(err?.message).toBe('Юзернейм должен начинаться с символа @');
        expect(validator.validateField(field, '@valid_handle')).toBeNull();
      });
    });

    describe('Content Validation (validateContent)', () => {
      const schema: TemplateSchema = {
        fields: [
          { key: 'title', label: 'Заголовок', type: 'text', required: true, maxLength: 100 },
          { key: 'body', label: 'Текст', type: 'rich_text', required: true },
          { key: 'cta', label: 'Ссылка', type: 'url', required: false },
        ],
      };

      it('should pass full valid content', () => {
        const result = validator.validateContent(schema, {
          title: 'Official News',
          body: '<b>Important update!</b>',
          cta: 'https://news.org',
        });
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should reject missing required fields when allowPartial is false', () => {
        const result = validator.validateContent(
          schema,
          { title: 'Only Title' },
          { allowPartial: false },
        );
        expect(result.isValid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.field).toBe('body');
      });

      it('should allow omitted required fields when allowPartial is true (wizard autosave)', () => {
        const result = validator.validateContent(
          schema,
          { title: 'Only Title' },
          { allowPartial: true },
        );
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });

    describe('Template Definition Validation (validateTemplateSchema)', () => {
      it('should reject non-array or empty fields', () => {
        expect(() => validator.validateTemplateSchema({})).toThrow(InvalidTemplateException);
        expect(() => validator.validateTemplateSchema({ fields: [] })).toThrow(
          InvalidTemplateException,
        );
      });

      it('should reject invalid or duplicate field keys', () => {
        expect(() =>
          validator.validateTemplateSchema({
            fields: [{ key: 'Invalid Key!', label: 'Test', type: 'text', required: true }],
          }),
        ).toThrow(InvalidTemplateException);

        expect(() =>
          validator.validateTemplateSchema({
            fields: [
              { key: 'duplicate', label: 'Test 1', type: 'text', required: true },
              { key: 'duplicate', label: 'Test 2', type: 'text', required: true },
            ],
          }),
        ).toThrow(InvalidTemplateException);
      });

      it('should reject invalid numeric bounds (maxLength < minLength, max < min)', () => {
        expect(() =>
          validator.validateTemplateSchema({
            fields: [
              {
                key: 'f1',
                label: 'Test',
                type: 'text',
                required: true,
                minLength: 10,
                maxLength: 5,
              },
            ],
          }),
        ).toThrow(InvalidTemplateException);

        expect(() =>
          validator.validateTemplateSchema({
            fields: [
              { key: 'f2', label: 'Test', type: 'number', required: true, min: 100, max: 10 },
            ],
          }),
        ).toThrow(InvalidTemplateException);
      });

      it('should reject invalid renderConfig layout', () => {
        expect(() =>
          validator.validateTemplateSchema(
            {
              fields: [{ key: 'f1', label: 'Test', type: 'text', required: true }],
            },
            { layout: '' },
          ),
        ).toThrow(InvalidTemplateException);
      });
    });
  });

  describe('TemplatesService', () => {
    const mockTemplate = {
      id: 'tpl-1',
      key: 'news',
      name: 'Новость',
      description: 'Короткая новость',
      schemaJson: {
        fields: [
          { key: 'headline', label: 'Заголовок', type: 'text', required: true },
          { key: 'body', label: 'Текст', type: 'rich_text', required: true },
        ],
      },
      renderConfig: { layout: '<b>{{headline}}</b>\n\n{{body}}' },
      supportedMediaTypes: ['photo'],
      version: 1,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should retrieve active templates ordered by createdAt', async () => {
      mockPrisma.postTemplate.findMany.mockResolvedValue([mockTemplate]);
      const result = await service.getActiveTemplates();
      expect(result).toEqual([mockTemplate]);
      expect(mockPrisma.postTemplate.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('should find template by UUID or slug key', async () => {
      mockPrisma.postTemplate.findUnique.mockResolvedValueOnce(mockTemplate);
      const byId = await service.getById('tpl-1');
      expect(byId.id).toBe('tpl-1');

      mockPrisma.postTemplate.findUnique.mockResolvedValueOnce(null);
      await expect(service.getById('missing')).rejects.toThrow(TemplateNotFoundException);

      mockPrisma.postTemplate.findUnique.mockResolvedValueOnce(mockTemplate);
      const byKey = await service.getByKey('news');
      expect(byKey.key).toBe('news');
    });

    it('should validate single field via template', async () => {
      mockPrisma.postTemplate.findUnique.mockResolvedValue(mockTemplate);
      const valid = await service.validateField('news', 'headline', 'Breaking News');
      expect(valid.isValid).toBe(true);

      const invalid = await service.validateField('news', 'headline', '');
      expect(invalid.isValid).toBe(false);

      const unknown = await service.validateField('news', 'unknown_field', 'val');
      expect(unknown.isValid).toBe(false);
      expect(unknown.errors[0]?.code).toBe('UNKNOWN_FIELD');
    });

    it('should create template after RBAC check and log audit entry', async () => {
      mockPrisma.postTemplate.findUnique.mockResolvedValue(null);
      mockPrisma.postTemplate.create.mockResolvedValue({
        ...mockTemplate,
        id: 'new-tpl',
        key: 'custom',
      });

      const result = await service.createTemplate(
        {
          key: 'custom',
          name: 'Пользовательский',
          schemaJson: mockTemplate.schemaJson as any,
          renderConfig: mockTemplate.renderConfig,
          supportedMediaTypes: ['photo'],
        },
        'admin-user',
      );

      expect(mockPermissionService.enforceSystemPermission).toHaveBeenCalledWith(
        'admin-user',
        SystemPermission.MANAGE_TEMPLATES,
      );
      expect(result.id).toBe('new-tpl');
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.SETTINGS_CHANGED,
          entityType: 'post_template',
          actorId: 'admin-user',
        }),
      );
    });

    it('should reject template creation if key already exists', async () => {
      mockPrisma.postTemplate.findUnique.mockResolvedValue(mockTemplate);

      await expect(
        service.createTemplate(
          {
            key: 'news',
            name: 'Duplicate',
            schemaJson: mockTemplate.schemaJson as any,
            renderConfig: mockTemplate.renderConfig,
            supportedMediaTypes: ['photo'],
          },
          'admin-user',
        ),
      ).rejects.toThrow(ValidationException);
    });

    it('should update template, increment version, and log audit', async () => {
      mockPrisma.postTemplate.findUnique.mockResolvedValue(mockTemplate);
      mockPrisma.postTemplate.update.mockResolvedValue({
        ...mockTemplate,
        name: 'Обновленная Новость',
        version: 2,
      });

      const updated = await service.updateTemplate(
        'tpl-1',
        { name: 'Обновленная Новость' },
        'admin-user',
      );

      expect(updated.version).toBe(2);
      expect(mockAuditService.record).toHaveBeenCalled();
    });

    it('should prevent deleting template if posts are associated with it', async () => {
      mockPrisma.postTemplate.findUnique.mockResolvedValue(mockTemplate);
      mockPrisma.post.count.mockResolvedValue(3);

      await expect(service.deleteTemplate('tpl-1', 'admin-user')).rejects.toThrow(
        ValidationException,
      );
      expect(mockPrisma.postTemplate.delete).not.toHaveBeenCalled();
    });

    it('should delete template if 0 posts are associated with it and log audit', async () => {
      mockPrisma.postTemplate.findUnique.mockResolvedValue(mockTemplate);
      mockPrisma.post.count.mockResolvedValue(0);
      mockPrisma.postTemplate.delete.mockResolvedValue(mockTemplate);

      await service.deleteTemplate('tpl-1', 'admin-user');

      expect(mockPrisma.postTemplate.delete).toHaveBeenCalledWith({ where: { id: 'tpl-1' } });
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.SETTINGS_CHANGED,
          entityType: 'post_template',
          entityId: 'tpl-1',
        }),
      );
    });
  });
});
