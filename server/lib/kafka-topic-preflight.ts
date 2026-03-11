// SPDX-License-Identifier: MIT
// Copyright (c) 2026 OmniNode Team
//
// kafka-topic-preflight.ts
//
// Preflight check: asserts that all required Kafka topics exist before the
// consumer subscribes. If any required topic is missing, throws an error
// that causes the process to crash-loop — the correct operator signal.
//
// Policy: crash-loop on startup IS the correct signal. Do not soften to a
// warning log or degraded-but-running state. A missing required topic means
// the data pipeline cannot function and the operator must act.
//
// Usage:
//   const admin = kafka.admin();
//   await assertTopicsExist(admin, ['onex.evt.omniclaude.skill-started.v1']);
//
// Ticket: OMN-4607 (OMN-4598 dashboard health regression prevention)

/**
 * Minimal interface for the Kafka admin client operations needed by this preflight.
 * Typed this way so it can be mocked cleanly in tests without importing kafkajs directly.
 */
export interface KafkaAdminClient {
  connect(): Promise<void>;
  listTopics(): Promise<string[]>;
  disconnect(): Promise<void>;
}

/**
 * Assert that all required Kafka topics exist on the broker.
 *
 * Connects the admin client, lists all topics, then disconnects.
 * The disconnect is guaranteed via try/finally — it always runs even if
 * connect or listTopics throws.
 *
 * @param admin - Kafka admin client instance (kafkajs Admin or compatible mock)
 * @param required - List of topic names that must exist
 * @throws Error with message "Required Kafka topic not found: <topic>" if any
 *         required topic is absent from the broker's topic list
 */
export async function assertTopicsExist(
  admin: KafkaAdminClient,
  required: string[]
): Promise<void> {
  try {
    await admin.connect();
    const existingTopics = await admin.listTopics();
    const existingSet = new Set(existingTopics);

    for (const topic of required) {
      if (!existingSet.has(topic)) {
        throw new Error(`Required Kafka topic not found: ${topic}`);
      }
    }
  } finally {
    await admin.disconnect();
  }
}
