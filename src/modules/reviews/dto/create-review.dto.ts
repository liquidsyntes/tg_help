import { ReviewAction } from '../../../common/enums';

export interface CreateReviewDto {
  postId: string;
  reviewerId: string;
  action: ReviewAction;
  comment?: string | null;
}
