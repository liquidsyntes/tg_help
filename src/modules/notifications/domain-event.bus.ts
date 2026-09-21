import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import { BaseDomainEvent, DomainEventType } from './events/domain-events';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';

@Injectable()
export class DomainEventBus {
  private readonly eventStream = new Subject<BaseDomainEvent>();

  constructor(private readonly logger: StructuredLoggerService) {}

  publish(event: BaseDomainEvent): void {
    this.logger.debug(
      {
        event: 'domain_event_published',
        eventType: event.eventType,
        postId: event.postId,
        channelId: event.channelId,
      },
      'DomainEventBus',
    );
    this.eventStream.next(event);
  }

  ofType<T extends BaseDomainEvent>(eventType: DomainEventType): Observable<T> {
    return this.eventStream.pipe(
      filter((e): e is T => e.eventType === eventType),
    );
  }

  asObservable(): Observable<BaseDomainEvent> {
    return this.eventStream.asObservable();
  }
}
