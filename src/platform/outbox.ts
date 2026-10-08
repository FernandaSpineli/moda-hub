import { Injectable } from '@nestjs/common';
import { currentCorrelationId } from '../common/request-context.js';
import { outboxEvents } from '../db/schema/index.js';
import type { Tx } from './database.js';

/** Domain events published through the outbox, with their payloads. */
export interface DomainEvents {
  'auth.password_reset_requested': { userId: string };
}

export type DomainEventType = keyof DomainEvents;

/**
 * Records a domain event in the caller's transaction. It is published to
 * the queue only after that transaction commits (see the outbox relay), so
 * an event can never describe a change that rolled back, nor be lost if the
 * process dies right after the commit.
 */
@Injectable()
export class OutboxService {
  async record<T extends DomainEventType>(
    tx: Tx,
    type: T,
    aggregateId: string,
    payload: DomainEvents[T],
  ): Promise<void> {
    await tx
      .insert(outboxEvents)
      .values({ type, aggregateId, payload, correlationId: currentCorrelationId() });
  }
}
