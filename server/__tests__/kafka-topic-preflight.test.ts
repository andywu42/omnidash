// SPDX-License-Identifier: MIT
// Copyright (c) 2026 OmniNode Team
//
// kafka-topic-preflight.test.ts
//
// Unit tests for assertTopicsExist() in kafka-topic-preflight.ts
//
// Ticket: OMN-4607 (OMN-4598 dashboard health regression prevention)

import { describe, it, expect, vi } from 'vitest';
import { assertTopicsExist, type KafkaAdminClient } from '../lib/kafka-topic-preflight';

function makeMockAdmin(topics: string[], connectError?: Error): KafkaAdminClient {
  return {
    connect: connectError
      ? vi.fn().mockRejectedValue(connectError)
      : vi.fn().mockResolvedValue(undefined),
    listTopics: vi.fn().mockResolvedValue(topics),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe('assertTopicsExist', () => {
  it('resolves when all required topics are present', async () => {
    const admin = makeMockAdmin([
      'onex.evt.omniclaude.skill-started.v1',
      'onex.evt.omniclaude.skill-completed.v1',
      'some.other.topic',
    ]);

    await expect(
      assertTopicsExist(admin, [
        'onex.evt.omniclaude.skill-started.v1',
        'onex.evt.omniclaude.skill-completed.v1',
      ])
    ).resolves.toBeUndefined();

    expect(admin.connect).toHaveBeenCalledOnce();
    expect(admin.listTopics).toHaveBeenCalledOnce();
    expect(admin.disconnect).toHaveBeenCalledOnce();
  });

  it('throws with the missing topic name when a required topic is absent', async () => {
    const admin = makeMockAdmin(['onex.evt.omniclaude.skill-started.v1']);

    await expect(
      assertTopicsExist(admin, [
        'onex.evt.omniclaude.skill-started.v1',
        'onex.evt.omniclaude.skill-completed.v1',
      ])
    ).rejects.toThrow('Required Kafka topic not found: onex.evt.omniclaude.skill-completed.v1');

    // disconnect must still be called exactly once (try/finally guarantee)
    expect(admin.disconnect).toHaveBeenCalledOnce();
  });

  it('calls disconnect exactly once when broker is unreachable (connect throws)', async () => {
    const brokerError = new Error('ECONNREFUSED: broker unreachable');
    const admin = makeMockAdmin([], brokerError);

    await expect(
      assertTopicsExist(admin, ['onex.evt.omniclaude.skill-started.v1'])
    ).rejects.toThrow('ECONNREFUSED: broker unreachable');

    // disconnect must be called even when connect throws
    expect(admin.disconnect).toHaveBeenCalledOnce();
  });
});
