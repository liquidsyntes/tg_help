import { Injectable } from '@nestjs/common';
import { PostTemplate, Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { TemplateValidator } from './template.validator';
import { AuditService } from '../audit/audit.service';
import { PermissionService } from '../auth/permission.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto';
import {
  TemplateSchema,
  TemplateRenderConfig,
  ValidationResult,
} from './interfaces/template.interface';
import { SystemPermission, AuditAction } from '../../common/enums';
import {
  TemplateNotFoundException,
  ValidationException,
} from '../../common/exceptions/domain.exceptions';

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: TemplateValidator,
    private readonly auditService: AuditService,
    private readonly permissionService: PermissionService,
  ) {}

  /**
   * Retrieves active templates for the Telegram wizard post creation menu.
   * Sorted by createdAt ascending to maintain stable ordering.
   */
  async getActiveTemplates(): Promise<PostTemplate[]> {
    return this.prisma.postTemplate.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Retrieves all templates (optionally including inactive) for administrative overview.
   */
  async findAll(includeInactive = false): Promise<PostTemplate[]> {
    return this.prisma.postTemplate.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Retrieves a template by its UUID. Throws TemplateNotFoundException if missing.
   */
  async getById(id: string): Promise<PostTemplate> {
    const template = await this.prisma.postTemplate.findUnique({
      where: { id },
    });
    if (!template) {
      throw new TemplateNotFoundException(id);
    }
    return template;
  }

  /**
   * Retrieves a template by its unique slug key. Throws TemplateNotFoundException if missing.
   */
  async getByKey(key: string): Promise<PostTemplate> {
    const template = await this.prisma.postTemplate.findUnique({
      where: { key },
    });
    if (!template) {
      throw new TemplateNotFoundException(key);
    }
    return template;
  }

  /**
   * Flexible lookup by either UUID or slug key.
   */
  async findByIdOrKey(idOrKey: string): Promise<PostTemplate> {
    let template = await this.prisma.postTemplate.findUnique({
      where: { id: idOrKey },
    });

    if (!template) {
      template = await this.prisma.postTemplate.findUnique({
        where: { key: idOrKey },
      });
    }

    if (!template) {
      throw new TemplateNotFoundException(idOrKey);
    }
    return template;
  }

  /**
   * Validates a single field value against a template.
   */
  async validateField(
    idOrKey: string,
    fieldKey: string,
    value: unknown,
  ): Promise<ValidationResult> {
    const template = await this.findByIdOrKey(idOrKey);
    const schema = template.schemaJson as unknown as TemplateSchema;
    const fieldDef = schema?.fields?.find((f) => f.key === fieldKey);

    if (!fieldDef) {
      return {
        isValid: false,
        errors: [
          {
            field: fieldKey,
            label: fieldKey,
            code: 'UNKNOWN_FIELD',
            message: `Поле «${fieldKey}» не найдено в шаблоне «${template.name}».`,
          },
        ],
      };
    }

    const error = this.validator.validateField(fieldDef, value);
    return {
      isValid: error === null,
      errors: error ? [error] : [],
    };
  }

  /**
   * Validates full post contentJson against a template.
   */
  async validatePostContent(
    idOrKey: string,
    contentJson: Record<string, unknown>,
    options?: { allowPartial?: boolean },
  ): Promise<ValidationResult> {
    const template = await this.findByIdOrKey(idOrKey);
    const schema = template.schemaJson as unknown as TemplateSchema;
    return this.validator.validateContent(schema, contentJson, options);
  }

  /**
   * Creates a new template. Enforces SUPER_ADMIN / MANAGE_TEMPLATES permission and audit logging.
   */
  async createTemplate(dto: CreateTemplateDto, actorId: string): Promise<PostTemplate> {
    await this.permissionService.enforceSystemPermission(
      actorId,
      SystemPermission.MANAGE_TEMPLATES,
    );

    this.validator.validateTemplateSchema(dto.schemaJson, dto.renderConfig);

    const existing = await this.prisma.postTemplate.findUnique({
      where: { key: dto.key },
    });
    if (existing) {
      throw new ValidationException(`Шаблон с ключом «${dto.key}» уже существует.`);
    }

    const template = await this.prisma.postTemplate.create({
      data: {
        key: dto.key,
        name: dto.name,
        description: dto.description ?? null,
        schemaJson: dto.schemaJson as unknown as Prisma.InputJsonValue,
        renderConfig: dto.renderConfig as unknown as Prisma.InputJsonValue,
        supportedMediaTypes: dto.supportedMediaTypes,
        isActive: dto.isActive ?? true,
      },
    });

    await this.auditService.record({
      action: AuditAction.SETTINGS_CHANGED,
      entityType: 'post_template',
      entityId: template.id,
      actorId,
      payload: {
        operation: 'create',
        key: template.key,
        name: template.name,
      },
    });

    return template;
  }

  /**
   * Updates an existing template. Validates schema if provided, increments version, logs audit entry.
   */
  async updateTemplate(
    id: string,
    dto: UpdateTemplateDto,
    actorId: string,
  ): Promise<PostTemplate> {
    await this.permissionService.enforceSystemPermission(
      actorId,
      SystemPermission.MANAGE_TEMPLATES,
    );

    const existing = await this.getById(id);

    if (dto.schemaJson || dto.renderConfig) {
      const targetSchema = dto.schemaJson ?? (existing.schemaJson as unknown as TemplateSchema);
      const targetConfig = dto.renderConfig ?? (existing.renderConfig as unknown as TemplateRenderConfig);
      this.validator.validateTemplateSchema(targetSchema, targetConfig);
    }

    const updateData: Prisma.PostTemplateUpdateInput = {
      name: dto.name,
      description: dto.description,
      supportedMediaTypes: dto.supportedMediaTypes,
      isActive: dto.isActive,
      version: { increment: 1 },
    };
    if (dto.schemaJson) {
      updateData.schemaJson = dto.schemaJson as unknown as Prisma.InputJsonValue;
    }
    if (dto.renderConfig) {
      updateData.renderConfig = dto.renderConfig as unknown as Prisma.InputJsonValue;
    }

    const updated = await this.prisma.postTemplate.update({
      where: { id },
      data: updateData,
    });

    await this.auditService.record({
      action: AuditAction.SETTINGS_CHANGED,
      entityType: 'post_template',
      entityId: updated.id,
      actorId,
      payload: {
        operation: 'update',
        previousVersion: existing.version,
        newVersion: updated.version,
      },
    });

    return updated;
  }

  /**
   * Toggles the active status of a template.
   */
  async setActive(id: string, isActive: boolean, actorId: string): Promise<PostTemplate> {
    return this.updateTemplate(id, { isActive }, actorId);
  }

  /**
   * Deletes a template only if no posts are associated with it.
   */
  async deleteTemplate(id: string, actorId: string): Promise<void> {
    await this.permissionService.enforceSystemPermission(
      actorId,
      SystemPermission.MANAGE_TEMPLATES,
    );

    const template = await this.getById(id);

    const postCount = await this.prisma.post.count({
      where: { templateId: id },
    });

    if (postCount > 0) {
      throw new ValidationException(
        `Нельзя удалить шаблон «${template.name}», так как к нему привязано публикаций: ${postCount}. Рекомендуется деактивировать шаблон.`,
      );
    }

    await this.prisma.postTemplate.delete({
      where: { id },
    });

    await this.auditService.record({
      action: AuditAction.SETTINGS_CHANGED,
      entityType: 'post_template',
      entityId: id,
      actorId,
      payload: {
        operation: 'delete',
        key: template.key,
        name: template.name,
      },
    });
  }
}
