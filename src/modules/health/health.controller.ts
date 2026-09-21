import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { LivenessResponse, ReadinessResponse } from './dto/health-response.dto';
import { HealthService } from './health.service';

@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  getHealth(): LivenessResponse {
    return this.healthService.checkLiveness();
  }

  @Get('ready')
  async getReady(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const readiness = await this.healthService.checkReadiness();
    if (readiness.status !== 'ok') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    } else {
      res.status(HttpStatus.OK);
    }
    return readiness;
  }
}
