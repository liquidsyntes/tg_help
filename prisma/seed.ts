import { PrismaClient, SystemRole, ChannelRole } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log('🌱 Starting database seeding...');

  // 1. Seed Initial Super Admin User
  const superAdminTelegramId = BigInt(
    process.env.INITIAL_SUPER_ADMIN_TELEGRAM_ID ?? '123456789',
  );

  const superAdmin = await prisma.user.upsert({
    where: { telegramId: superAdminTelegramId },
    update: {
      systemRole: SystemRole.SUPER_ADMIN,
      isActive: true,
    },
    create: {
      telegramId: superAdminTelegramId,
      username: 'admin',
      firstName: 'Super',
      lastName: 'Admin',
      systemRole: SystemRole.SUPER_ADMIN,
      isActive: true,
    },
  });
  console.log(`✅ Super Admin created/verified (ID: ${superAdmin.id})`);

  // 2. Seed Default Channel
  const defaultChatId = process.env.DEFAULT_CHANNEL_CHAT_ID ?? '-1001234567890';
  const channel = await prisma.channel.upsert({
    where: { telegramChatId: defaultChatId },
    update: {
      title: 'Основной канал',
      timezone: 'Europe/Kyiv',
      isActive: true,
    },
    create: {
      telegramChatId: defaultChatId,
      title: 'Основной канал',
      username: 'main_channel',
      timezone: 'Europe/Kyiv',
      publicationMode: 'DIRECT',
      isActive: true,
    },
  });
  console.log(`✅ Default Channel created/verified (ID: ${channel.id})`);

  // 3. Seed Channel Membership for Super Admin
  await prisma.channelMember.upsert({
    where: {
      channelId_userId: {
        channelId: channel.id,
        userId: superAdmin.id,
      },
    },
    update: {
      role: ChannelRole.EDITOR,
      canPublish: true,
      canApprove: true,
    },
    create: {
      channelId: channel.id,
      userId: superAdmin.id,
      role: ChannelRole.EDITOR,
      canPublish: true,
      canApprove: true,
    },
  });
  console.log('✅ Super Admin channel membership verified.');

  // 4. Seed 6 Standard Post Templates (tasks.md § 9, § 14)
  const templates = [
    {
      key: 'longread',
      name: '📝 Лонг-рид',
      description: 'Развёрнутая аналитическая статья с заголовком, лидом, форматированным текстом и медиа',
      supportedMediaTypes: ['photo', 'video', 'media_group'],
      schemaJson: {
        fields: [
          {
            key: 'title',
            label: 'Заголовок публикации',
            type: 'text',
            required: true,
            maxLength: 256,
            hint: 'Введите броский заголовок статьи',
          },
          {
            key: 'lead',
            label: 'Лид (краткое введение)',
            type: 'text',
            required: false,
            maxLength: 500,
            hint: '1-2 предложения, раскрывающие суть статьи',
          },
          {
            key: 'body',
            label: 'Основной текст',
            type: 'rich_text',
            required: true,
            maxLength: 3500,
            hint: 'Поддерживается Telegram HTML (жирный, курсив, цитаты, код)',
          },
        ],
      },
      renderConfig: {
        layout: '<b>{{title}}</b>\n\n<i>{{lead}}</i>\n\n{{body}}\n\n{{tags}}\n\n{{cta}}',
        headerTag: 'b',
        tagsPrefix: '\n\n',
      },
    },
    {
      key: 'announcement',
      name: '📢 Анонс',
      description: 'Анонс события, мероприятия или релиза с датой, местом и ссылкой',
      supportedMediaTypes: ['photo', 'video'],
      schemaJson: {
        fields: [
          {
            key: 'title',
            label: 'Название события',
            type: 'text',
            required: true,
            maxLength: 256,
            hint: 'Введите название мероприятия или релиза',
          },
          {
            key: 'event_date',
            label: 'Дата и время события',
            type: 'text',
            required: true,
            maxLength: 100,
            hint: 'Например: 25 сентября, 19:00 (Kyiv)',
          },
          {
            key: 'location',
            label: 'Место проведения / Ссылка',
            type: 'text',
            required: false,
            maxLength: 200,
            hint: 'Онлайн (Zoom/YouTube) или физический адрес',
          },
          {
            key: 'description',
            label: 'Описание мероприятия',
            type: 'rich_text',
            required: true,
            maxLength: 3000,
            hint: 'Программа, спикеры, детали события',
          },
          {
            key: 'cta_link',
            label: 'Ссылка на регистрацию',
            type: 'url',
            required: false,
            maxLength: 500,
            hint: 'https://example.com/register',
          },
        ],
      },
      renderConfig: {
        layout: '📢 <b>{{title}}</b>\n\n🗓 <b>Когда:</b> {{event_date}}\n📍 <b>Где:</b> {{location}}\n\n{{description}}\n\n{{cta}}',
      },
    },
    {
      key: 'photo',
      name: '🖼 Фото',
      description: 'Публикация с одним фото и подробной подписью',
      supportedMediaTypes: ['photo'],
      schemaJson: {
        fields: [
          {
            key: 'caption',
            label: 'Подпись к фотографии',
            type: 'rich_text',
            required: true,
            maxLength: 1024,
            hint: 'Текст подписи (до 1024 символов)',
          },
        ],
      },
      renderConfig: {
        layout: '{{caption}}\n\n{{tags}}',
      },
    },
    {
      key: 'video',
      name: '🎬 Видео',
      description: 'Видеоролик с заголовком и описанием',
      supportedMediaTypes: ['video'],
      schemaJson: {
        fields: [
          {
            key: 'title',
            label: 'Заголовок видео',
            type: 'text',
            required: true,
            maxLength: 256,
            hint: 'Короткий заголовок к видео',
          },
          {
            key: 'description',
            label: 'Описание видео',
            type: 'rich_text',
            required: false,
            maxLength: 768,
            hint: 'Описание сути видеоролика (до 768 символов)',
          },
        ],
      },
      renderConfig: {
        layout: '🎬 <b>{{title}}</b>\n\n{{description}}\n\n{{tags}}',
      },
    },
    {
      key: 'news',
      name: '📰 Новость',
      description: 'Короткая оперативная новость с ключевыми фактами и источником',
      supportedMediaTypes: ['photo', 'video'],
      schemaJson: {
        fields: [
          {
            key: 'headline',
            label: 'Заголовок новости',
            type: 'text',
            required: true,
            maxLength: 256,
            hint: 'Краткий новостной заголовок',
          },
          {
            key: 'facts',
            label: 'Ключевые факты',
            type: 'rich_text',
            required: true,
            maxLength: 3000,
            hint: 'Что произошло, подробности, цитаты',
          },
          {
            key: 'source_url',
            label: 'Ссылка на источник',
            type: 'url',
            required: false,
            maxLength: 500,
            hint: 'https://source.com/article',
          },
        ],
      },
      renderConfig: {
        layout: '⚡️ <b>{{headline}}</b>\n\n{{facts}}\n\n🔗 <a href="{{source_url}}">Источник</a>\n\n{{tags}}',
      },
    },
    {
      key: 'freeform',
      name: '✍️ Свободный формат',
      description: 'Произвольный текст с поддержкой любого медиа и свободного форматирования',
      supportedMediaTypes: ['photo', 'video', 'document', 'animation', 'media_group'],
      schemaJson: {
        fields: [
          {
            key: 'body',
            label: 'Текст публикации',
            type: 'rich_text',
            required: true,
            maxLength: 4096,
            hint: 'Любой текст с Telegram HTML форматированием',
          },
        ],
      },
      renderConfig: {
        layout: '{{body}}\n\n{{tags}}\n\n{{cta}}',
      },
    },
  ];

  for (const tpl of templates) {
    await prisma.postTemplate.upsert({
      where: { key: tpl.key },
      update: {
        name: tpl.name,
        description: tpl.description,
        supportedMediaTypes: tpl.supportedMediaTypes,
        schemaJson: tpl.schemaJson,
        renderConfig: tpl.renderConfig,
        isActive: true,
      },
      create: {
        key: tpl.key,
        name: tpl.name,
        description: tpl.description,
        supportedMediaTypes: tpl.supportedMediaTypes,
        schemaJson: tpl.schemaJson,
        renderConfig: tpl.renderConfig,
        isActive: true,
      },
    });
    console.log(`✅ Template "${tpl.key}" seeded.`);
  }

  console.log('🎉 Database seeding completed successfully.');
}

main()
  .catch((e: unknown) => {
    console.error('❌ Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
