export interface LivenessResponse {
  status: 'ok';
  uptime: number;
  timestamp: string;
}

export type DependencyStatus = 'up' | 'down';

export interface ReadinessResponse {
  status: 'ok' | 'down';
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
  errors?: Record<string, string>;
  timestamp: string;
}
