/**
 * Role-Based Main Menu Keyboard Builder
 * Authoritative reference: tasks.md § 8
 */

import { Keyboard } from 'grammy';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';
import { SystemRole, ChannelRole } from '../../../common/enums';

export function buildMainMenuKeyboard(user: AuthUser): Keyboard {
  const isSuperAdmin = user.systemRole === SystemRole.SUPER_ADMIN;
  const isEditorOrAdmin =
    isSuperAdmin || user.channelMemberships.some((m) => m.role === ChannelRole.EDITOR);

  const keyboard = new Keyboard();
  keyboard.text('➕ Создать пост').text('📑 Скопировать пост').row();

  if (isEditorOrAdmin) {
    keyboard.text('📝 Материалы').row();
    keyboard.text('✅ На согласовании').text('📅 Контент-план').row();
    keyboard.text('📚 Публикации');
    if (isSuperAdmin) {
      keyboard.text('👥 Пользователи').text('📄 Шаблоны').row();
      keyboard.text('⚙️ Настройки').text('❓ Помощь').row();
    } else {
      keyboard.text('❓ Помощь').row();
    }
  } else {
    keyboard.text('📝 Мои материалы').row();
    keyboard.text('📅 Контент-план').text('📚 Публикации').row();
    keyboard.text('❓ Помощь').row();
  }

  return keyboard.resized();
}
