/**
 * Empirical Verification Suite for Milestone 1
 *
 * Verifies live database invariants and BullMQ Redis connectivity:
 * 1. Duplicate User.telegramId -> DB throws unique constraint violation (Prisma P2002 & PG 23505)
 * 2. Duplicate Channel.telegramChatId -> DB throws unique constraint violation (Prisma P2002 & PG 23505)
 * 3. Duplicate ChannelMember(channelId, userId) -> DB throws unique constraint violation (Prisma P2002 & PG 23505)
 * 4. Duplicate PublicationJob.idempotencyKey -> DB throws unique constraint violation (Prisma P2002 & PG 23505)
 * 5. Post OCC version column default (version = 1) verified via Prisma create & native PostgreSQL DEFAULT
 * 6. BullMQ queue connectivity with Redis: adds dummy job to 'publication' queue and reads it back
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PUBLICATION_QUEUE_NAME } from '../../src/common/constants/queue-names';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

const results: TestResult[] = [];

async function runEmpiricalSuite() {
  console.log('================================================================');
  console.log('   STARTING EMPIRICAL VERIFICATION SUITE — MILESTONE 1');
  console.log('================================================================\n');

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: process.env.DATABASE_URL || 'postgresql://tghelp:tghelp_pass@127.0.0.1:5432/tghelp?schema=public',
      },
    },
  });

  const redisUrlStr = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const redisUrl = new URL(redisUrlStr);

  const publicationQueue = new Queue(PUBLICATION_QUEUE_NAME, {
    connection: {
      host: redisUrl.hostname || '127.0.0.1',
      port: Number(redisUrl.port) || 6379,
      password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
      username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
      maxRetriesPerRequest: null,
    },
  });

  try {
    await prisma.$connect();
    console.log('✅ Connected to PostgreSQL cluster at 127.0.0.1:5432.');

    // -------------------------------------------------------------------------
    // TEST 1: Duplicate User.telegramId
    // -------------------------------------------------------------------------
    console.log('\n--- [1/6] Test: Duplicate User.telegramId Invariant ---');
    const testTelegramId = 99998888777701n;
    await prisma.user.deleteMany({ where: { telegramId: testTelegramId } });

    const user1 = await prisma.user.create({
      data: {
        telegramId: testTelegramId,
        username: 'empirical_tester_1',
        firstName: 'Tester1',
        systemRole: 'USER',
      },
    });
    console.log(`- Created base user id=${user1.id}, telegramId=${user1.telegramId}`);

    // Test 1a: Prisma high-level create
    let prismaUserError: Prisma.PrismaClientKnownRequestError | null = null;
    try {
      await prisma.user.create({
        data: {
          telegramId: testTelegramId,
          username: 'empirical_duplicate_user',
          firstName: 'Duplicate',
          systemRole: 'USER',
        },
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        prismaUserError = err;
      }
    }

    // Test 1b: Native PostgreSQL raw SQL INSERT
    let rawPgUserError: string | null = null;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (id, telegram_id, updated_at) VALUES ($1, $2, NOW())`,
        'raw-user-dup-test',
        testTelegramId
      );
    } catch (err: unknown) {
      if (err instanceof Error) {
        rawPgUserError = err.message;
      }
    }

    await prisma.user.deleteMany({ where: { telegramId: testTelegramId } });

    const userP2002Ok = prismaUserError?.code === 'P2002';
    const userPg23505Ok = rawPgUserError?.includes('23505') ?? false;

    if (userP2002Ok && userPg23505Ok) {
      results.push({
        name: 'Invariant: Duplicate User.telegramId throws unique constraint violation',
        passed: true,
        details: { prismaCode: prismaUserError?.code, pgMessage: rawPgUserError },
      });
      console.log('✅ User.telegramId unique constraint: PASSED (Prisma P2002 & Postgres 23505)');
    } else {
      results.push({
        name: 'Invariant: Duplicate User.telegramId throws unique constraint violation',
        passed: false,
        error: `userP2002Ok=${userP2002Ok}, userPg23505Ok=${userPg23505Ok}`,
      });
      console.log('❌ User.telegramId unique constraint: FAILED');
    }

    // -------------------------------------------------------------------------
    // TEST 2: Duplicate Channel.telegramChatId
    // -------------------------------------------------------------------------
    console.log('\n--- [2/6] Test: Duplicate Channel.telegramChatId Invariant ---');
    const testChatId = '-100999988887701';
    await prisma.channel.deleteMany({ where: { telegramChatId: testChatId } });

    const channel1 = await prisma.channel.create({
      data: {
        telegramChatId: testChatId,
        title: 'Empirical Test Channel',
        timezone: 'Europe/Kyiv',
      },
    });
    console.log(`- Created base channel id=${channel1.id}, telegramChatId=${channel1.telegramChatId}`);

    // Test 2a: Prisma high-level create
    let prismaChannelError: Prisma.PrismaClientKnownRequestError | null = null;
    try {
      await prisma.channel.create({
        data: {
          telegramChatId: testChatId,
          title: 'Duplicate Channel',
          timezone: 'Europe/Kyiv',
        },
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        prismaChannelError = err;
      }
    }

    // Test 2b: Native PostgreSQL raw SQL INSERT
    let rawPgChannelError: string | null = null;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO channels (id, telegram_chat_id, title, updated_at) VALUES ($1, $2, $3, NOW())`,
        'raw-channel-dup-test',
        testChatId,
        'Raw Dup Channel'
      );
    } catch (err: unknown) {
      if (err instanceof Error) {
        rawPgChannelError = err.message;
      }
    }

    await prisma.channel.deleteMany({ where: { telegramChatId: testChatId } });

    const channelP2002Ok = prismaChannelError?.code === 'P2002';
    const channelPg23505Ok = rawPgChannelError?.includes('23505') ?? false;

    if (channelP2002Ok && channelPg23505Ok) {
      results.push({
        name: 'Invariant: Duplicate Channel.telegramChatId throws unique constraint violation',
        passed: true,
        details: { prismaCode: prismaChannelError?.code, pgMessage: rawPgChannelError },
      });
      console.log('✅ Channel.telegramChatId unique constraint: PASSED (Prisma P2002 & Postgres 23505)');
    } else {
      results.push({
        name: 'Invariant: Duplicate Channel.telegramChatId throws unique constraint violation',
        passed: false,
        error: `channelP2002Ok=${channelP2002Ok}, channelPg23505Ok=${channelPg23505Ok}`,
      });
      console.log('❌ Channel.telegramChatId unique constraint: FAILED');
    }

    // -------------------------------------------------------------------------
    // TEST 3: Duplicate ChannelMember(channelId, userId)
    // -------------------------------------------------------------------------
    console.log('\n--- [3/6] Test: Duplicate ChannelMember(channelId, userId) Composite Invariant ---');
    const memberUserTgId = 99998888777702n;
    const memberChatId = '-100999988887702';

    await prisma.user.deleteMany({ where: { telegramId: memberUserTgId } });
    await prisma.channel.deleteMany({ where: { telegramChatId: memberChatId } });

    const mUser = await prisma.user.create({
      data: {
        telegramId: memberUserTgId,
        firstName: 'MemberTester',
      },
    });

    const mChannel = await prisma.channel.create({
      data: {
        telegramChatId: memberChatId,
        title: 'Member Test Channel',
      },
    });

    const member1 = await prisma.channelMember.create({
      data: {
        channelId: mChannel.id,
        userId: mUser.id,
        role: 'AUTHOR',
      },
    });
    console.log(`- Created base member id=${member1.id} for user=${mUser.id}, channel=${mChannel.id}`);

    // Test 3a: Prisma high-level create
    let prismaMemberError: Prisma.PrismaClientKnownRequestError | null = null;
    try {
      await prisma.channelMember.create({
        data: {
          channelId: mChannel.id,
          userId: mUser.id,
          role: 'EDITOR',
        },
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        prismaMemberError = err;
      }
    }

    // Test 3b: Native PostgreSQL raw SQL INSERT
    let rawPgMemberError: string | null = null;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO channel_members (id, channel_id, user_id, updated_at) VALUES ($1, $2, $3, NOW())`,
        'raw-member-dup-test',
        mChannel.id,
        mUser.id
      );
    } catch (err: unknown) {
      if (err instanceof Error) {
        rawPgMemberError = err.message;
      }
    }

    await prisma.channelMember.deleteMany({ where: { channelId: mChannel.id, userId: mUser.id } });
    await prisma.channel.deleteMany({ where: { id: mChannel.id } });
    await prisma.user.deleteMany({ where: { id: mUser.id } });

    const memberP2002Ok = prismaMemberError?.code === 'P2002';
    const memberPg23505Ok = rawPgMemberError?.includes('23505') ?? false;

    if (memberP2002Ok && memberPg23505Ok) {
      results.push({
        name: 'Invariant: Duplicate ChannelMember(channelId, userId) throws unique constraint violation',
        passed: true,
        details: { prismaCode: prismaMemberError?.code, pgMessage: rawPgMemberError },
      });
      console.log('✅ ChannelMember composite unique constraint: PASSED (Prisma P2002 & Postgres 23505)');
    } else {
      results.push({
        name: 'Invariant: Duplicate ChannelMember(channelId, userId) throws unique constraint violation',
        passed: false,
        error: `memberP2002Ok=${memberP2002Ok}, memberPg23505Ok=${memberPg23505Ok}`,
      });
      console.log('❌ ChannelMember composite unique constraint: FAILED');
    }

    // -------------------------------------------------------------------------
    // TEST 4: Duplicate PublicationJob.idempotencyKey
    // -------------------------------------------------------------------------
    console.log('\n--- [4/6] Test: Duplicate PublicationJob.idempotencyKey Invariant ---');
    const pubUserTgId = 99998888777703n;
    const pubChatId = '-100999988887703';
    const testIdempotencyKey = 'publish:empirical-post-1:1';

    await prisma.publicationJob.deleteMany({ where: { idempotencyKey: testIdempotencyKey } });
    await prisma.user.deleteMany({ where: { telegramId: pubUserTgId } });
    await prisma.channel.deleteMany({ where: { telegramChatId: pubChatId } });

    const pUser = await prisma.user.create({
      data: {
        telegramId: pubUserTgId,
        firstName: 'PubTester',
      },
    });

    const pChannel = await prisma.channel.create({
      data: {
        telegramChatId: pubChatId,
        title: 'Pub Test Channel',
      },
    });

    let template = await prisma.postTemplate.findFirst({ where: { key: 'longread' } });
    if (!template) {
      template = await prisma.postTemplate.create({
        data: {
          key: 'longread-test-unique',
          name: 'Longread Unique Test',
          schemaJson: {},
          renderConfig: {},
        },
      });
    }

    const testPost = await prisma.post.create({
      data: {
        channelId: pChannel.id,
        authorId: pUser.id,
        templateId: template.id,
        contentJson: { title: 'Test Post' },
      },
    });

    const job1 = await prisma.publicationJob.create({
      data: {
        postId: testPost.id,
        postVersion: 1,
        idempotencyKey: testIdempotencyKey,
        channelId: pChannel.id,
        status: 'PENDING',
      },
    });
    console.log(`- Created base PublicationJob id=${job1.id}, idempotencyKey=${job1.idempotencyKey}`);

    // Test 4a: Prisma high-level create
    let prismaJobError: Prisma.PrismaClientKnownRequestError | null = null;
    try {
      await prisma.publicationJob.create({
        data: {
          postId: testPost.id,
          postVersion: 1,
          idempotencyKey: testIdempotencyKey,
          channelId: pChannel.id,
          status: 'PENDING',
        },
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        prismaJobError = err;
      }
    }

    // Test 4b: Native PostgreSQL raw SQL INSERT
    let rawPgJobError: string | null = null;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO publication_jobs (id, post_id, post_version, idempotency_key, channel_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        'raw-job-dup-test',
        testPost.id,
        1,
        testIdempotencyKey,
        pChannel.id
      );
    } catch (err: unknown) {
      if (err instanceof Error) {
        rawPgJobError = err.message;
      }
    }

    await prisma.publicationJob.deleteMany({ where: { idempotencyKey: testIdempotencyKey } });
    await prisma.post.deleteMany({ where: { id: testPost.id } });
    await prisma.channel.deleteMany({ where: { id: pChannel.id } });
    await prisma.user.deleteMany({ where: { id: pUser.id } });

    const jobP2002Ok = prismaJobError?.code === 'P2002';
    const jobPg23505Ok = rawPgJobError?.includes('23505') ?? false;

    if (jobP2002Ok && jobPg23505Ok) {
      results.push({
        name: 'Invariant: Duplicate PublicationJob.idempotencyKey throws unique constraint violation',
        passed: true,
        details: { prismaCode: prismaJobError?.code, pgMessage: rawPgJobError },
      });
      console.log('✅ PublicationJob.idempotencyKey unique constraint: PASSED (Prisma P2002 & Postgres 23505)');
    } else {
      results.push({
        name: 'Invariant: Duplicate PublicationJob.idempotencyKey throws unique constraint violation',
        passed: false,
        error: `jobP2002Ok=${jobP2002Ok}, jobPg23505Ok=${jobPg23505Ok}`,
      });
      console.log('❌ PublicationJob.idempotencyKey unique constraint: FAILED');
    }

    // -------------------------------------------------------------------------
    // TEST 5: Verify OCC version column default (version = 1) on Post
    // -------------------------------------------------------------------------
    console.log('\n--- [5/6] Test: Verify Post OCC version Column Default (version = 1) ---');
    const occUserTgId = 99998888777704n;
    const occChatId = '-100999988887704';

    await prisma.user.deleteMany({ where: { telegramId: occUserTgId } });
    await prisma.channel.deleteMany({ where: { telegramChatId: occChatId } });

    const occUser = await prisma.user.create({
      data: {
        telegramId: occUserTgId,
        firstName: 'OccTester',
      },
    });

    const occChannel = await prisma.channel.create({
      data: {
        telegramChatId: occChatId,
        title: 'Occ Test Channel',
      },
    });

    // 5a. Create post via Prisma without specifying version
    const occPost = await prisma.post.create({
      data: {
        channelId: occChannel.id,
        authorId: occUser.id,
        templateId: template.id,
        contentJson: { title: 'OCC Default Test' },
      },
    });

    const rawQueryResult = await prisma.$queryRaw<Array<{ version: number }>>`
      SELECT version FROM posts WHERE id = ${occPost.id}
    `;
    const rawVersionPrisma = rawQueryResult[0]?.version;
    console.log(`- Prisma create (omitting version): reported version=${occPost.version}, raw SQL fetch=${rawVersionPrisma}`);

    // 5b. Create post via pure raw SQL omitting the version column entirely to verify database column default
    const rawPostId = 'empirical-raw-post-' + Date.now();
    await prisma.$executeRawUnsafe(
      `INSERT INTO posts (id, channel_id, author_id, template_id, updated_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      rawPostId,
      occChannel.id,
      occUser.id,
      template.id
    );
    const rawSqlInsertResult = await prisma.$queryRaw<Array<{ version: number }>>`
      SELECT version FROM posts WHERE id = ${rawPostId}
    `;
    const rawVersionNative = rawSqlInsertResult[0]?.version;
    console.log(`- Native PostgreSQL raw INSERT (omitting version column entirely): DEFAULT value in DB=${rawVersionNative}`);

    // Clean up
    await prisma.post.deleteMany({ where: { id: { in: [occPost.id, rawPostId] } } });
    await prisma.channel.deleteMany({ where: { id: occChannel.id } });
    await prisma.user.deleteMany({ where: { id: occUser.id } });

    const isPrismaDefault1 = occPost.version === 1;
    const isRawSqlDefault1 = rawVersionPrisma === 1;
    const isNativePostgresDefault1 = rawVersionNative === 1;

    if (isPrismaDefault1 && isRawSqlDefault1 && isNativePostgresDefault1) {
      results.push({
        name: 'Invariant: Post OCC version column default = 1',
        passed: true,
        details: { prismaVersion: occPost.version, rawSqlPrisma: rawVersionPrisma, rawSqlNative: rawVersionNative },
      });
      console.log('✅ Post OCC version column default = 1: PASSED (verified Prisma + DB engine DEFAULT)');
    } else {
      results.push({
        name: 'Invariant: Post OCC version column default = 1',
        passed: false,
        error: `isPrismaDefault1=${isPrismaDefault1}, isRawSqlDefault1=${isRawSqlDefault1}, isNativePostgresDefault1=${isNativePostgresDefault1}`,
      });
      console.log('❌ Post OCC version column default = 1: FAILED');
    }

    // -------------------------------------------------------------------------
    // TEST 6: Verify BullMQ queue connectivity with Redis: add dummy job & read it
    // -------------------------------------------------------------------------
    console.log('\n--- [6/6] Test: BullMQ Queue Connectivity with Redis (Add & Read Job) ---');
    const dummyJobName = 'empirical-dummy-publish-test';
    const dummyJobPayload = {
      testId: 'empirical-' + Date.now(),
      postId: 'test-post-uuid',
      postVersion: 1,
      channelChatId: '-1001234567890',
      timestamp: new Date().toISOString(),
    };

    console.log(`- Adding dummy job "${dummyJobName}" to BullMQ "${PUBLICATION_QUEUE_NAME}" queue...`);
    const addedJob = await publicationQueue.add(dummyJobName, dummyJobPayload, {
      jobId: `test-job-${Date.now()}`,
      attempts: 3,
    });
    console.log(`- Job enqueued successfully! BullMQ Job ID: ${addedJob.id}`);

    console.log(`- Reading job ${addedJob.id} back from Redis...`);
    const fetchedJob = await publicationQueue.getJob(addedJob.id!);

    if (!fetchedJob) {
      throw new Error(`Job with ID ${addedJob.id} could not be retrieved from Redis!`);
    }

    console.log(`- Retrieved job from Redis: ID=${fetchedJob.id}, Name=${fetchedJob.name}`);
    console.log(`- Job payload:`, fetchedJob.data);

    const isNameMatch = fetchedJob.name === dummyJobName;
    const isDataMatch = (fetchedJob.data as typeof dummyJobPayload).testId === dummyJobPayload.testId;

    const jobCounts = await publicationQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    console.log('- BullMQ publication queue counts:', jobCounts);

    await fetchedJob.remove();
    console.log(`- Cleaned up test job ${addedJob.id} from Redis.`);

    if (isNameMatch && isDataMatch) {
      results.push({
        name: 'Connectivity: BullMQ queue connectivity with Redis (add and read job)',
        passed: true,
        details: { jobId: addedJob.id, jobName: fetchedJob.name, payload: fetchedJob.data, jobCounts },
      });
      console.log('✅ BullMQ queue connectivity with Redis: PASSED');
    } else {
      results.push({
        name: 'Connectivity: BullMQ queue connectivity with Redis (add and read job)',
        passed: false,
        error: `Job data mismatch: nameMatch=${isNameMatch}, dataMatch=${isDataMatch}`,
      });
      console.log('❌ BullMQ queue connectivity with Redis: FAILED');
    }

  } catch (error) {
    console.error('CRITICAL UNEXPECTED EXCEPTION DURING SUITE EXECUTION:', error);
    results.push({
      name: 'Empirical Suite Global Execution',
      passed: false,
      error: String(error),
    });
  } finally {
    await publicationQueue.close();
    await prisma.$disconnect();
    console.log('\nClosed BullMQ queue and PostgreSQL Prisma connections.');
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log('             EMPIRICAL VERIFICATION SUITE SUMMARY');
  console.log('================================================================');
  let allPassed = true;
  for (const res of results) {
    const mark = res.passed ? '✅ [PASS]' : '❌ [FAIL]';
    console.log(`${mark} ${res.name}${res.error ? ' - Error: ' + res.error : ''}`);
    if (!res.passed) allPassed = false;
  }
  console.log('================================================================');
  console.log(`FINAL VERDICT: ${allPassed ? 'ALL VERIFICATIONS PASSED' : 'VERIFICATION FAILURES DETECTED'}`);
  console.log('================================================================\n');

  if (!allPassed) {
    process.exit(1);
  }
}

runEmpiricalSuite().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
