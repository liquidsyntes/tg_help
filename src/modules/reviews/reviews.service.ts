import { Injectable } from '@nestjs/common';
import { Prisma, PostReview } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { ReviewAction } from '../../common/enums';
import { ValidationException } from '../../common/exceptions/domain.exceptions';
import { CreateReviewDto } from './dto/create-review.dto';

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a post review record.
   * Enforces mandatory non-empty comment on REQUEST_REVISION.
   * Can participate in a Prisma transaction.
   */
  async createReview(dto: CreateReviewDto, tx?: Prisma.TransactionClient): Promise<PostReview> {
    const client = tx || this.prisma;

    if (dto.action === ReviewAction.REQUEST_REVISION) {
      if (!dto.comment || dto.comment.trim().length === 0) {
        throw new ValidationException('Для возврата на доработку обязателен комментарий.');
      }
    }

    return client.postReview.create({
      data: {
        postId: dto.postId,
        reviewerId: dto.reviewerId,
        action: dto.action,
        comment: dto.comment ? dto.comment.trim() : null,
      },
    });
  }

  /**
   * Retrieves full review history for a post.
   */
  async getReviewsForPost(postId: string): Promise<PostReview[]> {
    return this.prisma.postReview.findMany({
      where: { postId },
      orderBy: { createdAt: 'asc' },
      include: {
        reviewer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
          },
        },
      },
    });
  }

  /**
   * Retrieves the most recent review (e.g. to display feedback to the author).
   */
  async getLatestReview(postId: string): Promise<PostReview | null> {
    return this.prisma.postReview.findFirst({
      where: { postId },
      orderBy: { createdAt: 'desc' },
      include: {
        reviewer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
          },
        },
      },
    });
  }
}
