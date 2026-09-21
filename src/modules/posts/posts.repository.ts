import { Injectable } from '@nestjs/common';
import { Prisma, Post, PostStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  PostConflictException,
  ValidationException,
} from '../../common/exceptions/domain.exceptions';
import { CreateDraftDto } from './dto/create-draft.dto';

@Injectable()
export class PostsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get activeFilter(): Prisma.PostWhereInput {
    return { deletedAt: null };
  }

  async findById(id: string, includeDeleted = false): Promise<Post | null> {
    return this.prisma.post.findFirst({
      where: {
        id,
        ...(includeDeleted ? {} : this.activeFilter),
      },
      include: {
        media: { orderBy: { sortOrder: 'asc' } },
        reviews: { orderBy: { createdAt: 'desc' } },
        template: true,
        author: true,
        channel: true,
      },
    });
  }

  async createDraft(dto: CreateDraftDto): Promise<Post> {
    return this.prisma.post.create({
      data: {
        authorId: dto.authorId,
        channelId: dto.channelId,
        templateId: dto.templateId,
        templateVersion: dto.templateVersion ?? 1,
        status: PostStatus.DRAFT,
        version: 1,
        contentJson: (dto.contentJson as Prisma.InputJsonValue) ?? {},
        metadataJson: (dto.metadataJson as Prisma.InputJsonValue) ?? {},
      },
      include: {
        template: true,
        author: true,
        channel: true,
      },
    });
  }

  /**
   * Optimistic Concurrency Control (OCC) atomic update.
   * Atomically checks WHERE id = :id AND version = :expectedVersion AND deleted_at IS NULL,
   * then increments version = version + 1.
   * Throws PostConflictException on version mismatch.
   * Throws ValidationException if post is missing or soft-deleted.
   */
  async updateWithOcc(
    postId: string,
    expectedVersion: number,
    data: Prisma.PostUpdateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Post> {
    const client = tx || this.prisma;

    const result = await client.post.updateMany({
      where: {
        id: postId,
        version: expectedVersion,
        deletedAt: null,
      },
      data: {
        ...data,
        version: { increment: 1 },
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      const existing = await client.post.findUnique({
        where: { id: postId },
        select: { id: true, version: true, deletedAt: true },
      });

      if (!existing || existing.deletedAt !== null) {
        throw new ValidationException(`Post "${postId}" not found or deleted.`);
      }

      throw new PostConflictException(postId, expectedVersion, existing.version);
    }

    return client.post.findUniqueOrThrow({
      where: { id: postId },
      include: {
        media: { orderBy: { sortOrder: 'asc' } },
        reviews: { orderBy: { createdAt: 'desc' } },
        template: true,
        author: true,
        channel: true,
      },
    });
  }

  async softDelete(
    postId: string,
    expectedVersion: number,
    tx?: Prisma.TransactionClient,
  ): Promise<Post> {
    return this.updateWithOcc(
      postId,
      expectedVersion,
      {
        deletedAt: new Date(),
      },
      tx,
    );
  }

  async findPendingReview(channelId: string): Promise<Post[]> {
    return this.prisma.post.findMany({
      where: {
        channelId,
        status: PostStatus.PENDING_REVIEW,
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      include: {
        author: true,
        template: true,
        reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
  }

  async findByChannel(channelId: string, status?: PostStatus): Promise<Post[]> {
    return this.prisma.post.findMany({
      where: {
        channelId,
        ...(status ? { status } : {}),
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        author: true,
        template: true,
      },
    });
  }

  async findByAuthor(authorId: string, status?: PostStatus): Promise<Post[]> {
    return this.prisma.post.findMany({
      where: {
        authorId,
        ...(status ? { status } : {}),
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        channel: true,
        template: true,
      },
    });
  }
}
