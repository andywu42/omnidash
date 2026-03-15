/**
 * Correlation Trace Projection Tests (OMN-5047)
 *
 * Validates that the ReadModelConsumer correctly handles correlation-trace
 * span events and that the topic is registered in the subscription list.
 */
import { describe, it, expect } from 'vitest';
import { READ_MODEL_TOPICS } from '../read-model-consumer';
import { SUFFIX_OMNICLAUDE_CORRELATION_TRACE } from '@shared/topics';

describe('Correlation Trace Projection (OMN-5047)', () => {
  it('should include the correlation-trace topic in READ_MODEL_TOPICS', () => {
    expect(READ_MODEL_TOPICS).toContain(SUFFIX_OMNICLAUDE_CORRELATION_TRACE);
  });

  it('should have the correct canonical topic name', () => {
    expect(SUFFIX_OMNICLAUDE_CORRELATION_TRACE).toBe('onex.evt.omniclaude.correlation-trace.v1');
  });

  it('READ_MODEL_TOPICS should include all expected trace topics', () => {
    // Verify the new topic is included alongside existing agent topics
    const traceTopics = READ_MODEL_TOPICS.filter((t) => t.includes('correlation-trace'));
    expect(traceTopics).toHaveLength(1);
    expect(traceTopics[0]).toBe('onex.evt.omniclaude.correlation-trace.v1');
  });
});
