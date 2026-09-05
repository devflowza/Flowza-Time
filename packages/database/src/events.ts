import type { DomainEventType } from '@flowza/contracts';
import type { Trx } from './context.js';

export interface DomainEventInput {
  organizationId: string | null;
  eventType: DomainEventType;
  aggregateType: string;
  aggregateId?: string | null;
  payload?: Record<string, unknown>;
  actorUserId?: string | null;
  requestId?: string | null;
}

/** Transactional outbox write. The worker relays unpublished events to notifications/realtime/webhooks. */
export async function emitDomainEvent(trx: Trx, input: DomainEventInput): Promise<void> {
  await trx
    .insertInto('domainEvents')
    .values({
      organizationId: input.organizationId,
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId ?? null,
      payload: JSON.stringify(input.payload ?? {}),
      actorUserId: input.actorUserId ?? null,
      requestId: input.requestId ?? null,
    })
    .execute();
}
