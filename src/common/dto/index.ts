/**
 * Common DTOs
 * Authoritative reference: AGENTS.md § 7, § 64
 */

export class PaginationQueryDto {
  page?: number = 1;
  limit?: number = 20;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface StandardApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
}
