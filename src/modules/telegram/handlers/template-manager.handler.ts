import { Injectable } from '@nestjs/common';
import { BotContext } from '../interfaces/bot-context.interface';
import { TemplatesService } from '../../templates/templates.service';
import { TemplateManagerService } from '../services/template-manager.service';
import { TemplateKeyboardBuilder } from '../keyboards/template-manager.keyboard';
import { TemplateSchema } from '../../templates/interfaces/template.interface';
import { InlineKeyboard } from 'grammy';
import { ChannelRole, SystemRole, PostStatus } from '../../../common/enums';
import { TelegramRenderer } from '../../rendering/telegram-renderer.service';
import { Post } from '@prisma/client';

@Injectable()
export class TemplateManagerHandler {
  constructor(
    private readonly templatesService: TemplatesService,
    private readonly sessionService: TemplateManagerService,
    private readonly renderer: TelegramRenderer,
  ) {}

  private canManageTemplates(ctx: BotContext): boolean {
    const user = ctx.authUser;
    if (!user) return false;
    return (
      user.systemRole === SystemRole.SUPER_ADMIN ||
      user.channelMemberships.some((m) => m.role === ChannelRole.EDITOR)
    );
  }

  async handlePreview(ctx: BotContext, templateId: string): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    const template = await this.templatesService.getById(templateId);
    const schema = template.schemaJson as unknown as TemplateSchema;
    
    // Generate dummy content
    const dummyContent: Record<string, any> = {};
    for (const field of schema.fields || []) {
      switch (field.type) {
        case 'rich_text':
          dummyContent[field.key] = `<b>${field.label}</b>\nЭто пример форматированного многострочного текста. Здесь можно писать <i>курсивом</i> или вставлять ссылки.`;
          break;
        case 'text':
          dummyContent[field.key] = `Пример текста: ${field.label}`;
          break;
        case 'textarea':
          dummyContent[field.key] = `Длинный текстовый абзац для поля "${field.label}".\nОн может занимать несколько строк.`;
          break;
        case 'number':
          dummyContent[field.key] = 42;
          break;
        case 'url':
          dummyContent[field.key] = 'https://example.com';
          break;
        default:
          dummyContent[field.key] = `[${field.type}]`;
      }
    }
    
    const mockPost = {
      contentJson: dummyContent,
      author: ctx.authUser,
    } as unknown as Post;
    
    const renderedText = this.renderer.renderHtml(mockPost, template);
    
    await ctx.answerCallbackQuery();
    await ctx.reply(`👁 <b>Предпросмотр шаблона «${template.name}»:</b>\n\n${renderedText}`, { parse_mode: 'HTML' });
  }

  async handleListTemplates(ctx: BotContext): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    
    await this.sessionService.clearSession(ctx.authUser!.id);
    
    const templates = await this.templatesService.findAll(true);
    const kb = TemplateKeyboardBuilder.buildList(templates);
    
    const text = '📄 <b>Управление шаблонами</b>\n\nВыберите шаблон для редактирования:';
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  }

  async handleViewTemplate(ctx: BotContext, templateId: string): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    await this.sessionService.clearSession(ctx.authUser!.id);
    
    const template = await this.templatesService.getById(templateId);
    const kb = TemplateKeyboardBuilder.buildView(template);
    const schema = template.schemaJson as unknown as TemplateSchema;
    
    const text = `📄 <b>Шаблон:</b> ${template.name}\n` +
                 `🔑 <b>Ключ:</b> ${template.key}\n` +
                 `📝 <b>Полей:</b> ${schema.fields?.length || 0}\n\n` +
                 `${template.description ? `<i>${template.description}</i>` : 'Без описания'}`;
                 
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  }

  async handlePromptRename(ctx: BotContext, templateId: string): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    await this.sessionService.saveSession(ctx.authUser!.id, { action: 'WAIT_RENAME', templateId });
    
    const kb = new InlineKeyboard().text('🔙 Отмена', `tpl:view:${templateId}`);
    await ctx.editMessageText('✏️ Введите новое название для шаблона:', { reply_markup: kb });
  }

  async handlePromptDesc(ctx: BotContext, templateId: string): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    await this.sessionService.saveSession(ctx.authUser!.id, { action: 'WAIT_DESC', templateId });
    
    const kb = new InlineKeyboard().text('🔙 Отмена', `tpl:view:${templateId}`);
    await ctx.editMessageText('ℹ️ Введите новое описание для шаблона (или отправьте "-", чтобы удалить):', { reply_markup: kb });
  }

  async handlePromptLayout(ctx: BotContext, templateId: string): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    const template = await this.templatesService.getById(templateId);
    const schema = template.schemaJson as unknown as TemplateSchema;
    const renderConfig = template.renderConfig as Record<string, any>;
    const layout = renderConfig.layout || '';
    
    const fieldKeys = (schema.fields || []).map(f => `{{${f.key}}}`).join(', ');
    
    await this.sessionService.saveSession(ctx.authUser!.id, { action: 'WAIT_LAYOUT', templateId });
    
    const text = `🎨 <b>Настройка внешнего вида (Layout)</b>\n\n` +
                 `Текущая разметка:\n<code>${layout}</code>\n\n` +
                 `Вы можете вписать любой текст, смайлики, линии или разделители. ` +
                 `Чтобы вставить значение поля, используйте его ключ в двойных фигурных скобках.\n\n` +
                 `Доступные ключи полей: <code>${fieldKeys}</code>\n` +
                 `Системные ключи: <code>{{author_name}}, {{author_mention}}, {{author_link}}</code>\n\n` +
                 `Отправьте новую разметку текстом:`;
                 
    const kb = new InlineKeyboard().text('🔙 Отмена', `tpl:view:${templateId}`);
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  }

  async handlePromptClone(ctx: BotContext, templateId: string): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    await this.sessionService.saveSession(ctx.authUser!.id, { action: 'WAIT_CLONE_KEY', templateId });
    
    const kb = new InlineKeyboard().text('🔙 Отмена', `tpl:view:${templateId}`);
    await ctx.editMessageText('🗂 Введите уникальный <b>ключ</b> (slug) для нового шаблона (только латиница и цифры):', { parse_mode: 'HTML', reply_markup: kb });
  }

  async handleDelete(ctx: BotContext, templateId: string): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    try {
      await this.templatesService.deleteTemplate(templateId, ctx.authUser!.id);
      await ctx.answerCallbackQuery({ text: '✅ Шаблон удален', show_alert: true });
      await this.handleListTemplates(ctx);
    } catch (e: any) {
      await ctx.answerCallbackQuery({ text: `❌ Ошибка: ${e.message}`, show_alert: true });
    }
  }

  async handleListFields(ctx: BotContext, templateId: string): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    await this.sessionService.clearSession(ctx.authUser!.id);
    
    const template = await this.templatesService.getById(templateId);
    const kb = TemplateKeyboardBuilder.buildFieldsList(template);
    
    const text = `📝 <b>Поля шаблона:</b> ${template.name}`;
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  }

  async handleViewField(ctx: BotContext, templateId: string, fieldIndex: number): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    
    const template = await this.templatesService.getById(templateId);
    const schema = template.schemaJson as unknown as TemplateSchema;
    const field = schema.fields![fieldIndex];
    if (!field) return;
    
    const kb = TemplateKeyboardBuilder.buildFieldView(templateId, fieldIndex, field);
    
    const text = `▪️ <b>Поле:</b> ${field.label}\n` +
                 `🔄 <b>Тип:</b> ${field.type}\n` +
                 `⚠️ <b>Обязательное:</b> ${field.required ? 'Да' : 'Нет'}\n` +
                 `🔑 <b>Ключ (в БД):</b> ${field.key}`;
                 
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  }

  async handleSetFieldType(ctx: BotContext, templateId: string, fieldIndex: number, newType: string): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    
    const template = await this.templatesService.getById(templateId);
    const schema = template.schemaJson as unknown as TemplateSchema;
    if (schema.fields && schema.fields[fieldIndex]) {
      schema.fields[fieldIndex].type = newType as any;
      await this.templatesService.updateTemplate(templateId, { schemaJson: schema as any }, ctx.authUser!.id);
    }
    
    await this.handleViewField(ctx, templateId, fieldIndex);
  }

  async handleToggleFieldReq(ctx: BotContext, templateId: string, fieldIndex: number): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    
    const template = await this.templatesService.getById(templateId);
    const schema = template.schemaJson as unknown as TemplateSchema;
    if (schema.fields && schema.fields[fieldIndex]) {
      schema.fields[fieldIndex].required = !schema.fields[fieldIndex].required;
      await this.templatesService.updateTemplate(templateId, { schemaJson: schema as any }, ctx.authUser!.id);
    }
    
    await this.handleViewField(ctx, templateId, fieldIndex);
  }

  async handleDeleteField(ctx: BotContext, templateId: string, fieldIndex: number): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    
    const template = await this.templatesService.getById(templateId);
    const schema = template.schemaJson as unknown as TemplateSchema;
    if (schema.fields && schema.fields[fieldIndex]) {
      schema.fields.splice(fieldIndex, 1);
      await this.templatesService.updateTemplate(templateId, { schemaJson: schema as any }, ctx.authUser!.id);
    }
    
    await ctx.answerCallbackQuery({ text: '✅ Поле удалено' });
    await this.handleListFields(ctx, templateId);
  }

  async handlePromptAddField(ctx: BotContext, templateId: string): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    await this.sessionService.saveSession(ctx.authUser!.id, { action: 'WAIT_FIELD_LABEL', templateId });
    
    const kb = new InlineKeyboard().text('🔙 Отмена', `tpl:fields:${templateId}`);
    await ctx.editMessageText('➕ Введите название (Label) нового поля (например, "Текст новости"):', { reply_markup: kb });
  }

  async handlePromptFieldRename(ctx: BotContext, templateId: string, fieldIndex: number): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    await this.sessionService.saveSession(ctx.authUser!.id, { action: 'WAIT_FIELD_RENAME', templateId, tempData: { fieldIndex } });
    
    const kb = new InlineKeyboard().text('🔙 Отмена', `tpl:f_view:${templateId}:${fieldIndex}`);
    await ctx.editMessageText('✏️ Введите новое название (Label) для поля:', { reply_markup: kb });
  }

  async handlePromptFieldHint(ctx: BotContext, templateId: string, fieldIndex: number): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    await this.sessionService.saveSession(ctx.authUser!.id, { action: 'WAIT_FIELD_HINT', templateId, tempData: { fieldIndex } });
    
    const kb = new InlineKeyboard().text('🔙 Отмена', `tpl:f_view:${templateId}:${fieldIndex}`);
    await ctx.editMessageText('💡 Введите новую подсказку для поля (или отправьте "-", чтобы удалить):', { reply_markup: kb });
  }

  async handlePromptFieldMax(ctx: BotContext, templateId: string, fieldIndex: number): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    await this.sessionService.saveSession(ctx.authUser!.id, { action: 'WAIT_FIELD_MAX', templateId, tempData: { fieldIndex } });
    
    const kb = new InlineKeyboard().text('🔙 Отмена', `tpl:f_view:${templateId}:${fieldIndex}`);
    await ctx.editMessageText('📏 Введите максимальное количество символов (или отправьте "-", чтобы снять ограничение):', { reply_markup: kb });
  }

  async handlePromptFieldMin(ctx: BotContext, templateId: string, fieldIndex: number): Promise<void> {
    if (!this.canManageTemplates(ctx)) return;
    await this.sessionService.saveSession(ctx.authUser!.id, { action: 'WAIT_FIELD_MIN', templateId, tempData: { fieldIndex } });
    
    const kb = new InlineKeyboard().text('🔙 Отмена', `tpl:f_view:${templateId}:${fieldIndex}`);
    await ctx.editMessageText('📐 Введите минимальное количество символов (или отправьте "-", чтобы снять ограничение):', { reply_markup: kb });
  }

  async handleTextInput(ctx: BotContext): Promise<boolean> {
    const user = ctx.authUser;
    if (!user || !ctx.message?.text) return false;
    
    const session = await this.sessionService.getSession(user.id);
    if (!session) return false;
    
    const templateId = session.templateId;
    
    if (session.action === 'WAIT_RENAME') {
      await this.templatesService.updateTemplate(templateId, { name: ctx.message.text }, user.id);
      await ctx.reply(`✅ Шаблон переименован в «${ctx.message.text}»`);
      await this.handleViewTemplate(ctx, templateId);
      return true;
    }
    
    if (session.action === 'WAIT_CLONE_KEY') {
      const newKey = ctx.message.text.trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(newKey)) {
        await ctx.reply('❌ Ключ может содержать только латинские буквы, цифры, дефис и подчеркивание. Попробуйте снова:');
        return true;
      }
      await this.sessionService.saveSession(user.id, { action: 'WAIT_CLONE_NAME', templateId, tempData: { newKey } });
      await ctx.reply('Введите название для нового шаблона:');
      return true;
    }
    
    if (session.action === 'WAIT_CLONE_NAME') {
      const template = await this.templatesService.getById(templateId);
      const newKey = session.tempData.newKey;
      const newName = ctx.message.text;
      
      try {
        const newTpl = await this.templatesService.createTemplate({
          key: newKey,
          name: newName,
          description: template.description ?? undefined,
          schemaJson: template.schemaJson as any,
          renderConfig: template.renderConfig as any,
          supportedMediaTypes: template.supportedMediaTypes,
        }, user.id);
        
        await ctx.reply(`✅ Шаблон успешно скопирован!`);
        await this.handleViewTemplate(ctx, newTpl.id);
      } catch (e: any) {
        await ctx.reply(`❌ Ошибка копирования: ${e.message}`);
        await this.handleViewTemplate(ctx, templateId);
      }
      return true;
    }
    
    if (session.action === 'WAIT_DESC') {
      const desc = ctx.message.text === '-' ? null : ctx.message.text;
      await this.templatesService.updateTemplate(templateId, { description: desc }, user.id);
      await ctx.reply(`✅ Описание шаблона обновлено`);
      await this.handleViewTemplate(ctx, templateId);
      return true;
    }

    if (session.action === 'WAIT_LAYOUT') {
      const newLayout = ctx.message.text;
      const template = await this.templatesService.getById(templateId);
      const renderConfig = (template.renderConfig || {}) as Record<string, any>;
      renderConfig.layout = newLayout;
      
      await this.templatesService.updateTemplate(templateId, { renderConfig: renderConfig as any }, user.id);
      await ctx.reply(`✅ Разметка шаблона успешно обновлена!`);
      await this.handleViewTemplate(ctx, templateId);
      return true;
    }

    if (session.action === 'WAIT_FIELD_LABEL') {
      const label = ctx.message.text;
      const template = await this.templatesService.getById(templateId);
      const schema = template.schemaJson as unknown as TemplateSchema;
      
      if (!schema.fields) schema.fields = [];
      const newFieldKey = 'field_' + Date.now();
      
      schema.fields.push({
        key: newFieldKey,
        type: 'rich_text',
        label,
        required: false,
      });
      
      await this.templatesService.updateTemplate(templateId, { schemaJson: schema as any }, user.id);
      await ctx.reply(`✅ Поле «${label}» добавлено!`);
      await this.handleListFields(ctx, templateId);
      return true;
    }

    if (session.action === 'WAIT_FIELD_RENAME') {
      const label = ctx.message.text;
      const fieldIndex = session.tempData.fieldIndex;
      const template = await this.templatesService.getById(templateId);
      const schema = template.schemaJson as unknown as TemplateSchema;
      if (schema.fields && schema.fields[fieldIndex]) {
        schema.fields[fieldIndex].label = label;
        await this.templatesService.updateTemplate(templateId, { schemaJson: schema as any }, user.id);
        await ctx.reply(`✅ Название поля обновлено`);
      }
      await this.handleViewField(ctx, templateId, fieldIndex);
      return true;
    }

    if (session.action === 'WAIT_FIELD_HINT') {
      const hint = ctx.message.text === '-' ? undefined : ctx.message.text;
      const fieldIndex = session.tempData.fieldIndex;
      const template = await this.templatesService.getById(templateId);
      const schema = template.schemaJson as unknown as TemplateSchema;
      if (schema.fields && schema.fields[fieldIndex]) {
        schema.fields[fieldIndex].hint = hint;
        await this.templatesService.updateTemplate(templateId, { schemaJson: schema as any }, user.id);
        await ctx.reply(`✅ Подсказка поля обновлена`);
      }
      await this.handleViewField(ctx, templateId, fieldIndex);
      return true;
    }

    if (session.action === 'WAIT_FIELD_MAX') {
      const text = ctx.message.text.trim();
      const val = text === '-' ? undefined : parseInt(text, 10);
      const fieldIndex = session.tempData.fieldIndex;
      if (text !== '-' && (isNaN(val!) || val! <= 0)) {
        await ctx.reply('❌ Пожалуйста, введите положительное число (или "-" для удаления ограничения).');
        return true;
      }
      
      const template = await this.templatesService.getById(templateId);
      const schema = template.schemaJson as unknown as TemplateSchema;
      if (schema.fields && schema.fields[fieldIndex]) {
        schema.fields[fieldIndex].maxLength = val;
        await this.templatesService.updateTemplate(templateId, { schemaJson: schema as any }, user.id);
        await ctx.reply(`✅ Максимальная длина поля обновлена`);
      }
      await this.handleViewField(ctx, templateId, fieldIndex);
      return true;
    }

    if (session.action === 'WAIT_FIELD_MIN') {
      const text = ctx.message.text.trim();
      const val = text === '-' ? undefined : parseInt(text, 10);
      const fieldIndex = session.tempData.fieldIndex;
      if (text !== '-' && (isNaN(val!) || val! < 0)) {
        await ctx.reply('❌ Пожалуйста, введите положительное число (или "-" для удаления ограничения).');
        return true;
      }
      
      const template = await this.templatesService.getById(templateId);
      const schema = template.schemaJson as unknown as TemplateSchema;
      if (schema.fields && schema.fields[fieldIndex]) {
        schema.fields[fieldIndex].minLength = val;
        await this.templatesService.updateTemplate(templateId, { schemaJson: schema as any }, user.id);
        await ctx.reply(`✅ Минимальная длина поля обновлена`);
      }
      await this.handleViewField(ctx, templateId, fieldIndex);
      return true;
    }

    return false;
  }
}
