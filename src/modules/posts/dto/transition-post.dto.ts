import { PostStatus, PostAction } from '../../../common/enums';

export class TransitionPostDto {
  postId: string;
  expectedVersion: number;
  targetStatus?: PostStatus;
  action?: PostAction;
  actorId: string;
  comment?: string | null;
  scheduledAt?: Date | null;
}
