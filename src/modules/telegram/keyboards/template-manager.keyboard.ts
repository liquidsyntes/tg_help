import { InlineKeyboard } from 'grammy';
import { PostTemplate } from '@prisma/client';
import { TemplateSchema, TemplateFieldDefinition } from '../../templates/interfaces/template.interface';

export class TemplateKeyboardBuilder {
  static buildList(templates: PostTemplate[]): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const t of templates) {
      kb.text(`📄 ${t.name}`, `tpl:view:${t.id}`).row();
    }
    return kb;
  }

  static buildView(template: PostTemplate): InlineKeyboard {
    const kb = new InlineKeyboard();
    kb.text('✏️ Название', `tpl:rename:${template.id}`).text('ℹ️ Описание', `tpl:desc:${template.id}`).row();
    kb.text('🎨 Настроить внешний вид (Layout)', `tpl:layout:${template.id}`).row();
    kb.text('👀 Предпросмотр', `tpl:prev:${template.id}`).row();
    kb.text('📝 Настроить поля', `tpl:fields:${template.id}`).row();
    kb.text('🗂 Скопировать как...', `tpl:clone:${template.id}`).row();
    kb.text('❌ Удалить', `tpl:del:${template.id}`).row();
    kb.text('🔙 К списку шаблонов', `tpl:list`).row();
    return kb;
  }

  static buildFieldsList(template: PostTemplate): InlineKeyboard {
    const kb = new InlineKeyboard();
    const schema = template.schemaJson as unknown as TemplateSchema;
    const fields = schema.fields || [];

    fields.forEach((f, idx) => {
      kb.text(`▪️ ${f.label} (${f.type})`, `tpl:f_view:${template.id}:${idx}`).row();
    });

    kb.text('➕ Добавить поле', `tpl:f_add:${template.id}`).row();
    kb.text('🔙 Назад к шаблону', `tpl:view:${template.id}`).row();
    return kb;
  }

  static buildFieldView(templateId: string, fieldIndex: number, field: TemplateFieldDefinition): InlineKeyboard {
    const kb = new InlineKeyboard();
    
    // Label & Hint
    kb.text('✏️ Название (Label)', `tpl:f_ren:${templateId}:${fieldIndex}`).text('💡 Подсказка', `tpl:f_hint:${templateId}:${fieldIndex}`).row();
    
    // Lengths
    kb.text(`📏 Макс. длина: ${field.maxLength || 'Нет'}`, `tpl:f_max:${templateId}:${fieldIndex}`).text(`📐 Мин. длина: ${field.minLength || 'Нет'}`, `tpl:f_min:${templateId}:${fieldIndex}`).row();

    // Type cycling
    const nextType = this.getNextType(field.type);
    kb.text(`🔄 Тип: ${field.type} ➡️ ${nextType}`, `tpl:f_type:${templateId}:${fieldIndex}:${nextType}`).row();
    
    // Required toggle
    kb.text(`⚠️ Сделать: ${!field.required ? 'Обязательным' : 'Необязательным'}`, `tpl:f_req:${templateId}:${fieldIndex}`).row();
    
    kb.text('❌ Удалить поле', `tpl:f_del:${templateId}:${fieldIndex}`).row();
    kb.text('🔙 К списку полей', `tpl:fields:${templateId}`).row();
    return kb;
  }

  private static getNextType(current: string): string {
    const types = ['rich_text', 'text', 'textarea', 'number', 'url'];
    const idx = types.indexOf(current);
    if (idx === -1 || idx === types.length - 1) return types[0]!;
    return types[idx + 1]!;
  }
}
