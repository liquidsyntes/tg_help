/**
 * Wizard Inline Keyboards
 * Builds channel selection, template selection, and field input controls.
 * Authoritative reference: tasks.md § 9; AGENTS.md § 14, § 18
 */

import { InlineKeyboard } from 'grammy';
import { Channel, PostTemplate } from '@prisma/client';
import { TemplateFieldDefinition } from '../../templates/interfaces/template.interface';

export class WizardKeyboardBuilder {
  /**
   * Channel Selection Keyboard
   */
  static buildChannelSelection(channels: Channel[]): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const ch of channels) {
      kb.text(`📢 ${ch.title}`, `wiz:chan:${ch.id}`).row();
    }
    kb.text('❌ Отмена', 'wiz:cancel');
    return kb;
  }

  /**
   * Template Selection Keyboard (2 items per row)
   */
  static buildTemplateSelection(templates: PostTemplate[]): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (let i = 0; i < templates.length; i += 2) {
      const t1 = templates[i];
      const t2 = templates[i + 1];

      if (t1) {
        kb.text(`${t1.name}`, `wiz:tpl:${t1.id}`);
      }
      if (t2) {
        kb.text(`${t2.name}`, `wiz:tpl:${t2.id}`);
      }
      kb.row();
    }
    kb.text('❌ Отмена', 'wiz:cancel');
    return kb;
  }

  /**
   * Field Input Action Keyboard
   */
  static buildFieldInputControls(field: TemplateFieldDefinition): InlineKeyboard {
    const kb = new InlineKeyboard();
    if (!field.required) {
      kb.text('⏭ Пропустить поле', `wiz:skip:${field.key}`).row();
    }
    kb.text('💾 Сохранить и выйти', 'wiz:cancel');
    return kb;
  }

  /**
   * Media Upload Control Keyboard
   */
  static buildMediaUploadControls(): InlineKeyboard {
    const kb = new InlineKeyboard();
    kb.text('✅ Завершить добавление медиа', 'wiz:done_media').row();
    kb.text('💾 Сохранить и выйти', 'wiz:cancel');
    return kb;
  }
}
