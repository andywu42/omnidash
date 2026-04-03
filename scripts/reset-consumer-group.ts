/* eslint-disable no-console */
/**
 * Reset Consumer Group Script (OMN-6393)
 *
 * Deletes the omnidash-read-model consumer group offsets so the consumer
 * replays all events from the earliest retained offset on next startup.
 *
 * Usage:
 *   npx tsx scripts/reset-consumer-group.ts
 *   npx tsx scripts/reset-consumer-group.ts --group omnidash-read-model-v1
 *
 * Idempotent: safe to run multiple times. If the group does not exist,
 * the script exits cleanly.
 *
 * Prerequisites:
 *   - Kafka/Redpanda must be running
 *   - The omnidash consumer must be STOPPED before running this script
 *     (otherwise offsets will be re-committed immediately)
 */

import { Kafka, logLevel } from 'kafkajs';

const DEFAULT_GROUP_ID = process.env.READ_MODEL_CONSUMER_GROUP_ID || 'omnidash-read-model-v1';
const BROKERS = (
  process.env.KAFKA_BROKERS ||
  process.env.KAFKA_BOOTSTRAP_SERVERS ||
  'localhost:19092'
).split(',');

async function main(): Promise<void> {
  const groupId = process.argv.includes('--group')
    ? process.argv[process.argv.indexOf('--group') + 1]
    : DEFAULT_GROUP_ID;

  console.log(`[reset-consumer-group] Resetting consumer group: ${groupId}`);
  console.log(`[reset-consumer-group] Brokers: ${BROKERS.join(', ')}`);

  const kafka = new Kafka({
    clientId: 'omnidash-reset-consumer-group',
    brokers: BROKERS,
    logLevel: logLevel.WARN,
  });

  const admin = kafka.admin();
  await admin.connect();

  try {
    // Check if group exists
    const groups = await admin.listGroups();
    const groupExists = groups.groups.some((g) => g.groupId === groupId);

    if (!groupExists) {
      console.log(`[reset-consumer-group] Group "${groupId}" does not exist -- nothing to reset`);
      return;
    }

    // Delete the consumer group (which removes all committed offsets)
    await admin.deleteGroups([groupId]);
    console.log(`[reset-consumer-group] Successfully deleted consumer group "${groupId}"`);
    console.log(
      '[reset-consumer-group] On next startup, the consumer will replay from earliest offsets'
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Group might be active -- need to stop consumer first
    if (msg.includes('NON_EMPTY_GROUP') || msg.includes('not empty')) {
      console.error(
        `[reset-consumer-group] ERROR: Group "${groupId}" has active members.\n` +
          `Stop the omnidash consumer before running this script.`
      );
      process.exit(1);
    }
    throw err;
  } finally {
    await admin.disconnect();
  }
}

main().catch((err) => {
  console.error('[reset-consumer-group] Fatal error:', err);
  process.exit(1);
});
