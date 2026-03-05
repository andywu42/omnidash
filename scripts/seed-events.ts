#!/usr/bin/env tsx

/* eslint-disable no-console */

/**
 * Seed Kafka Events Script
 *
 * Publishes test events to Kafka topics for dashboard testing.
 * Run with: npm run seed-events or tsx scripts/seed-events.ts
 */

import 'dotenv/config';
import { Kafka, Partitioners } from 'kafkajs';
import { randomUUID } from 'crypto';
import { TOPIC_OMNICLAUDE_ROUTING_DECISIONS, TOPIC_OMNICLAUDE_AGENT_ACTIONS } from '@shared/topics';

const brokers = process.env.KAFKA_BROKERS || process.env.KAFKA_BOOTSTRAP_SERVERS;
if (!brokers) {
  console.error(
    '❌ Error: KAFKA_BROKERS or KAFKA_BOOTSTRAP_SERVERS environment variable is required.'
  );
  console.error('   Set it in .env file or export it before running this script.');
  console.error('   Example: KAFKA_BROKERS=host:port');
  process.exit(1);
}

const kafka = new Kafka({
  brokers: brokers.split(','),
  clientId: 'omnidash-seed-script',
});

const producer = kafka.producer({
  createPartitioner: Partitioners.DefaultPartitioner,
});

const AGENT_NAMES = [
  'agent-polymorphic',
  'agent-api-architect',
  'agent-performance',
  'agent-debug',
  'agent-test',
];

const ACTION_TYPES = ['tool_call', 'decision', 'error', 'success'];
const ACTION_NAMES = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'];

const ROUTING_STRATEGIES = [
  'enhanced_fuzzy_matching',
  'explicit_agent_selection',
  'fallback_routing',
  'capability_based',
];

function randomItem<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateRoutingDecision(correlationId: string) {
  return {
    id: randomUUID(),
    correlation_id: correlationId,
    user_request: `Test user request ${randomInt(1, 1000)}`,
    selected_agent: randomItem(AGENT_NAMES),
    confidence_score: 0.7 + Math.random() * 0.3, // 0.7-1.0
    routing_strategy: randomItem(ROUTING_STRATEGIES),
    alternatives: AGENT_NAMES.slice(0, 2).map((name) => ({
      agent: name,
      confidence: 0.5 + Math.random() * 0.3,
    })),
    reasoning: 'High confidence match based on trigger and context',
    routing_time_ms: randomInt(20, 150),
    timestamp: new Date().toISOString(),
  };
}

function generateAgentAction(correlationId: string) {
  return {
    id: randomUUID(),
    correlation_id: correlationId,
    agent_name: randomItem(AGENT_NAMES),
    action_type: randomItem(ACTION_TYPES),
    action_name: randomItem(ACTION_NAMES),
    action_details: {
      test: true,
      params: { file_path: '/test/file.txt' },
    },
    debug_mode: Math.random() > 0.5,
    duration_ms: randomInt(10, 500),
    timestamp: new Date().toISOString(),
  };
}

async function seedEvents(count: number = 10) {
  console.log(`\n🌱 Seeding ${count} test events to Kafka topics...\n`);

  try {
    await producer.connect();
    console.log('✅ Producer connected to Kafka\n');

    const messages: Array<{ topic: string; key: string; value: string }> = [];

    for (let i = 0; i < count; i++) {
      const correlationId = randomUUID();

      // Routing decision event
      const routingEvent = generateRoutingDecision(correlationId);
      messages.push({
        topic: TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
        key: routingEvent.selected_agent,
        value: JSON.stringify(routingEvent),
      });

      // 2-5 action events per routing decision
      const actionCount = randomInt(2, 5);
      for (let j = 0; j < actionCount; j++) {
        const actionEvent = generateAgentAction(correlationId);
        messages.push({
          topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
          key: actionEvent.agent_name,
          value: JSON.stringify(actionEvent),
        });
      }
    }

    // Send all messages in batches
    console.log(
      `📤 Publishing ${messages.length} events (${count} routing decisions + actions)...`
    );

    for (const msg of messages) {
      await producer.send({
        topic: msg.topic,
        messages: [{ key: msg.key, value: msg.value }],
      });
    }

    console.log('\n✅ All events published successfully!\n');
    console.log('📊 Summary:');
    console.log(`   - Routing decisions: ${count}`);
    console.log(`   - Agent actions: ${messages.length - count}`);
    console.log(`   - Total events: ${messages.length}`);
    console.log('\n💡 Check the dashboard at http://localhost:3000 to see the data\n');
  } catch (error) {
    console.error('❌ Error seeding events:', error);
    throw error;
  } finally {
    await producer.disconnect();
    console.log('👋 Producer disconnected\n');
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const count = args.length > 0 ? parseInt(args[0], 10) : 10;

if (isNaN(count) || count < 1) {
  console.error('Usage: tsx scripts/seed-events.ts [count]');
  console.error('Example: tsx scripts/seed-events.ts 50');
  process.exit(1);
}

seedEvents(count)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
