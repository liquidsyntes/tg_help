import { IsUUID, IsInt, Min, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SchedulePostDto {
  @IsUUID()
  postId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsNotEmpty()
  scheduledAt!: string | Date;

  @IsOptional()
  @IsString()
  timezone?: string;
}
