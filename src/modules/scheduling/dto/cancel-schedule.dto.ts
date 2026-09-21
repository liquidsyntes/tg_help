import { IsUUID, IsInt, Min, IsOptional, IsBoolean } from 'class-validator';

export class CancelScheduleDto {
  @IsUUID()
  postId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsOptional()
  @IsBoolean()
  returnToApproved?: boolean;
}
