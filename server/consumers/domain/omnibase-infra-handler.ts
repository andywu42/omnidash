/**
 * OmniBase Infra domain handler [OMN-5191 / OMN-5293]
 *
 * Handles topics with the omnibase-infra prefix:
 * - Circuit breaker state transition events (OMN-5293)
 */

import type { KafkaMessage } from 'kafkajs';
import { SUFFIX_OMNIBASE_INFRA_CIRCUIT_BREAKER } from '@shared/topics';
import { tryGetIntelligenceDb } from '../../storage';
import { circuitBreakerEvents } from '@shared/intelligence-schema';
import type { DomainHandler, ConsumerContext } from './types';

const HANDLED_TOPICS = new Set([SUFFIX_OMNIBASE_INFRA_CIRCUIT_BREAKER]);

// ============================================================================
// Raw Kafka payload type
// ============================================================================

interface RawCircuitBreakerEvent {
  service_name?: string;
  serviceName?: string;
  state?: string;
  previous_state?: string;
  previousState?: string;
  failure_count?: number;
  failureCount?: number;
  threshold?: number;
  timestamp?: string;
  correlation_id?: string;
  correlationId?: string;
}

// ============================================================================
// Handler
// ============================================================================

async function handleCircuitBreakerEvent(
  event: RawCircuitBreakerEvent,
  ctx: ConsumerContext
): Promise<void> {
  const db = tryGetIntelligenceDb();
  if (!db) return;

  const serviceName = event.service_name ?? event.serviceName ?? 'unknown';
  const state = event.state ?? 'closed';
  const previousState = event.previous_state ?? event.previousState ?? 'closed';
  const failureCount = event.failure_count ?? event.failureCount ?? 0;
  const threshold = event.threshold ?? 5;
  const rawTs = event.timestamp;
  const emittedAt = rawTs ? new Date(rawTs) : new Date();

  try {
    await db.insert(circuitBreakerEvents).values({
      serviceName,
      state,
      previousState,
      failureCount,
      threshold,
      emittedAt,
    });

    ctx.emit('circuit-breaker-event', {
      serviceName,
      state,
      previousState,
      failureCount,
      threshold,
      emittedAt: emittedAt.toISOString(),
    });
  } catch (err) {
    // Log but never block the consumer
    console.error('[omnibase-infra-handler] Failed to persist circuit breaker event:', err);
  }
}

// ============================================================================
// DomainHandler implementation
// ============================================================================

export class OmnibaseInfraHandler implements DomainHandler {
  readonly name = 'omnibase-infra';

  canHandle(topic: string): boolean {
    return HANDLED_TOPICS.has(topic);
  }

  async handleEvent(
    topic: string,
    event: Record<string, unknown>,
    _message: KafkaMessage,
    ctx: ConsumerContext
  ): Promise<void> {
    if (topic === SUFFIX_OMNIBASE_INFRA_CIRCUIT_BREAKER) {
      await handleCircuitBreakerEvent(event as RawCircuitBreakerEvent, ctx);
    }
  }
}
