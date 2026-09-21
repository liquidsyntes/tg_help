export interface ReorderMediaItemDto {
  mediaId: string;
  sortOrder: number;
}

export class ReorderMediaDto {
  orders!: ReorderMediaItemDto[];
}
