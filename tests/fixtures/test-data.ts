/**
 * Test Fixtures & Seed Data for Telegram Content Publisher Bot MVP E2E Tests.
 * Authoritative Sources: tasks.md §4, §8, §9, §14; AGENTS.md §8, §9; PROJECT.md
 */

export interface TestUser {
  id: string;
  telegramUserId: bigint;
  systemRole: 'SUPER_ADMIN' | 'USER';
  channelRole: 'EDITOR' | 'AUTHOR' | 'VIEWER';
  canPublish: boolean;
  canApprove: boolean;
  isActive: boolean;
  displayName: string;
}

export interface TestChannel {
  id: string;
  telegramChatId: string;
  title: string;
  username: string;
  timezone: string;
  isActive: boolean;
}

export interface TestTemplate {
  id: string;
  key: string;
  name: string;
  schemaJson: {
    fields: Array<{
      key: string;
      type: 'text' | 'rich_text' | 'url';
      required?: boolean;
      maxLength?: number;
    }>;
  };
  supportedMediaTypes: string[];
}

export const TEST_USERS: Record<string, TestUser> = {
  superAdmin: {
    id: 'usr-admin-001',
    telegramUserId: 100000001n,
    systemRole: 'SUPER_ADMIN',
    channelRole: 'EDITOR',
    canPublish: true,
    canApprove: true,
    isActive: true,
    displayName: 'Super Admin User',
  },
  editor: {
    id: 'usr-editor-001',
    telegramUserId: 200000001n,
    systemRole: 'USER',
    channelRole: 'EDITOR',
    canPublish: true,
    canApprove: true,
    isActive: true,
    displayName: 'Chief Editor',
  },
  author: {
    id: 'usr-author-001',
    telegramUserId: 300000001n,
    systemRole: 'USER',
    channelRole: 'AUTHOR',
    canPublish: false,
    canApprove: false,
    isActive: true,
    displayName: 'Staff Author',
  },
  deactivatedUser: {
    id: 'usr-deact-001',
    telegramUserId: 800000001n,
    systemRole: 'USER',
    channelRole: 'AUTHOR',
    canPublish: false,
    canApprove: false,
    isActive: false,
    displayName: 'Deactivated User',
  },
  unauthorizedUser: {
    id: 'usr-unknown-001',
    telegramUserId: 999999999n,
    systemRole: 'USER',
    channelRole: 'VIEWER',
    canPublish: false,
    canApprove: false,
    isActive: false,
    displayName: 'Stranger User',
  },
};

export const TEST_CHANNELS: Record<string, TestChannel> = {
  production: {
    id: 'chan-prod-001',
    telegramChatId: '-1001987654321',
    title: 'Main Editorial News',
    username: 'main_editorial_news',
    timezone: 'Europe/Kyiv',
    isActive: true,
  },
  staging: {
    id: 'chan-stage-001',
    telegramChatId: '-1001122334455',
    title: 'Staging Channel',
    username: 'staging_channel_test',
    timezone: 'Europe/Kyiv',
    isActive: true,
  },
  archived: {
    id: 'chan-archived-001',
    telegramChatId: '-1001999999999',
    title: 'Old Inactive Channel',
    username: 'old_channel',
    timezone: 'UTC',
    isActive: false,
  },
};

export const TEST_TEMPLATES: Record<string, TestTemplate> = {
  news: {
    id: 'tmpl-news-001',
    key: 'news',
    name: '📰 Новость',
    schemaJson: {
      fields: [
        { key: 'title', type: 'text', required: true, maxLength: 256 },
        { key: 'body', type: 'rich_text', required: true, maxLength: 4000 },
        { key: 'sourceUrl', type: 'url', required: false, maxLength: 512 },
      ],
    },
    supportedMediaTypes: ['photo', 'video'],
  },
  longread: {
    id: 'tmpl-longread-001',
    key: 'longread',
    name: '📝 Лонг-рид',
    schemaJson: {
      fields: [
        { key: 'title', type: 'text', required: true, maxLength: 256 },
        { key: 'lead', type: 'rich_text', required: true, maxLength: 1000 },
        { key: 'body', type: 'rich_text', required: true, maxLength: 8000 },
      ],
    },
    supportedMediaTypes: ['photo', 'video', 'document'],
  },
  photo: {
    id: 'tmpl-photo-001',
    key: 'photo',
    name: '🖼 Фото',
    schemaJson: {
      fields: [
        { key: 'caption', type: 'rich_text', required: true, maxLength: 1024 },
      ],
    },
    supportedMediaTypes: ['photo'],
  },
};
