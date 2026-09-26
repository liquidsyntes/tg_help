import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../infrastructure/redis/redis.service';
import { TemplateSessionData } from '../interfaces/template-session.interface';

@Injectable()
export class TemplateManagerService {
  constructor(private readonly redis: RedisService) {}

  private sessionKey(actorId: string): string {
    return `tpl_manager:session:${actorId}`;
  }

  async getSession(actorId: string): Promise<TemplateSessionData | null> {
    const data = await this.redis.get(this.sessionKey(actorId));
    if (!data) return null;
    return JSON.parse(data) as TemplateSessionData;
  }

  async saveSession(actorId: string, data: TemplateSessionData): Promise<void> {
    await this.redis.set(this.sessionKey(actorId), JSON.stringify(data), 3600);
  }

  async clearSession(actorId: string): Promise<void> {
    await this.redis.del(this.sessionKey(actorId));
  }
}
