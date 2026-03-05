#!/usr/bin/env tsx

/* eslint-disable no-console */

/**
 * Kafka Topic Checker
 *
 * Checks the status of Kafka topics and consumer group offsets
 * Run with: npm run check-topics or tsx scripts/check-kafka-topics.ts
 */

import { Kafka } from 'kafkajs';
import { OMNICLAUDE_AGENT_TOPICS } from '@shared/topics';

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
  clientId: 'omnidash-topic-checker',
});

const TOPICS_TO_CHECK = [...OMNICLAUDE_AGENT_TOPICS];

const CONSUMER_GROUP = 'omnidash-consumers-v2';

async function checkTopics() {
  const admin = kafka.admin();

  try {
    await admin.connect();
    console.log('✅ Connected to Kafka\n');

    // Fetch topic metadata
    console.log('📊 Topic Information:\n');
    const topics = await admin.fetchTopicMetadata({ topics: TOPICS_TO_CHECK });

    for (const topic of topics.topics) {
      console.log(`Topic: ${topic.name}`);
      console.log(`  Partitions: ${topic.partitions.length}`);

      for (const partition of topic.partitions) {
        console.log(`    Partition ${partition.partitionId}:`);
        console.log(`      Leader: ${partition.leader}`);
        console.log(`      Replicas: ${partition.replicas.join(', ')}`);
        console.log(`      ISR: ${partition.isr.join(', ')}`);
      }

      // Fetch topic offsets (high water mark = number of messages)
      const offsets = await admin.fetchTopicOffsets(topic.name);
      const totalMessages = offsets.reduce((sum, o) => sum + parseInt(o.high), 0);
      console.log(`  📬 Total messages: ${totalMessages}\n`);
    }

    // Check consumer group offsets
    console.log(`\n👥 Consumer Group: ${CONSUMER_GROUP}\n`);
    try {
      const groups = await admin.describeGroups([CONSUMER_GROUP]);
      const group = groups.groups[0];

      if (group) {
        console.log(`  State: ${group.state}`);
        console.log(`  Protocol: ${group.protocol}`);
        console.log(`  Members: ${group.members.length}`);

        for (const member of group.members) {
          console.log(`    - ${member.memberId.substring(0, 40)}...`);
        }

        // Fetch consumer group offsets
        console.log('\n  📖 Consumer Offsets:\n');
        const offsets = await admin.fetchOffsets({
          groupId: CONSUMER_GROUP,
          topics: TOPICS_TO_CHECK,
        });

        for (const topic of offsets) {
          console.log(`  ${topic.topic}:`);
          for (const partition of topic.partitions) {
            const offset = partition.offset === '-1' ? 'No offset' : partition.offset;
            console.log(`    Partition ${partition.partition}: ${offset}`);
          }
        }
      } else {
        console.log('  ⚠️ Consumer group not found');
      }
    } catch (_error) {
      console.error(
        '  ⚠️ Error fetching consumer group info:',
        _error instanceof Error ? _error.message : _error
      );
    }

    console.log('\n✅ Topic check complete\n');
  } catch (error) {
    console.error('❌ Error checking topics:', error);
    throw error;
  } finally {
    await admin.disconnect();
  }
}

checkTopics()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
