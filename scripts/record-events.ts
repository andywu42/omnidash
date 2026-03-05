#!/usr/bin/env npx tsx
/* eslint-disable no-console */
/**
 * Event Recording Script
 *
 * Captures real Kafka events and saves them to a JSONL file for demo playback.
 * Run locally where Kafka is available, then upload the recording to Replit.
 *
 * Usage:
 *   npx tsx scripts/record-events.ts [options]
 *
 * Options:
 *   --duration <seconds>   Recording duration (default: 60)
 *   --output <file>        Output file path (default: demo/recordings/events-{timestamp}.jsonl)
 *   --topics <list>        Comma-separated topic list (default: all subscribed topics)
 *
 * Examples:
 *   npx tsx scripts/record-events.ts --duration 120
 *   npx tsx scripts/record-events.ts --output demo/recordings/full-demo.jsonl
 */

import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import { buildSubscriptionTopics } from '@shared/topics';

// Configuration
const brokersEnv = process.env.KAFKA_BOOTSTRAP_SERVERS || process.env.KAFKA_BROKERS;
if (!brokersEnv) {
  console.error(
    'Error: KAFKA_BOOTSTRAP_SERVERS or KAFKA_BROKERS environment variable is required.'
  );
  console.error('   Set it in .env file or export it before running this script.');
  process.exit(1);
}
const KAFKA_BROKERS = brokersEnv.split(',');
const DEFAULT_DURATION_SECONDS = 60;

// Topics to record - same as event-consumer.ts plus pattern learning topic
const DEFAULT_TOPICS = [...buildSubscriptionTopics()];

interface RecordedEvent {
  timestamp: string;
  relativeMs: number; // Milliseconds from recording start
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: unknown;
}

function getArgValue(args: string[], index: number, flagName: string): string {
  const nextIndex = index + 1;
  if (nextIndex >= args.length) {
    console.error(`Error: ${flagName} requires a value`);
    process.exit(1);
  }
  const value = args[nextIndex];
  if (value.startsWith('--')) {
    console.error(`Error: ${flagName} requires a value, got another flag: ${value}`);
    process.exit(1);
  }
  return value;
}

function parseArgs(): {
  duration: number;
  output: string;
  topics: string[];
} {
  const args = process.argv.slice(2);
  let duration = DEFAULT_DURATION_SECONDS;
  let output = '';
  let topics = DEFAULT_TOPICS;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--duration': {
        const durationStr = getArgValue(args, i, '--duration');
        i++; // Skip the value we just consumed
        const parsed = parseInt(durationStr, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          console.error(`Error: --duration must be a positive number, got: ${durationStr}`);
          process.exit(1);
        }
        duration = parsed;
        break;
      }
      case '--output': {
        const outputStr = getArgValue(args, i, '--output');
        i++; // Skip the value we just consumed
        if (outputStr.trim() === '') {
          console.error('Error: --output cannot be empty');
          process.exit(1);
        }
        output = outputStr;
        break;
      }
      case '--topics': {
        const topicsStr = getArgValue(args, i, '--topics');
        i++; // Skip the value we just consumed
        if (topicsStr.trim() === '') {
          console.error('Error: --topics cannot be empty');
          process.exit(1);
        }
        topics = topicsStr
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t !== '');
        if (topics.length === 0) {
          console.error('Error: --topics must contain at least one valid topic');
          process.exit(1);
        }
        break;
      }
      default:
        if (args[i].startsWith('--')) {
          console.error(`Error: Unknown option: ${args[i]}`);
          console.error('Valid options: --duration <seconds>, --output <file>, --topics <list>');
          process.exit(1);
        }
    }
  }

  // Default output path with timestamp
  if (!output) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    output = `demo/recordings/events-${timestamp}.jsonl`;
  }

  return { duration, output, topics };
}

async function recordEvents(): Promise<void> {
  const { duration, output, topics } = parseArgs();

  console.log('='.repeat(60));
  console.log('Event Recording');
  console.log('='.repeat(60));
  console.log(`Duration:    ${duration} seconds`);
  console.log(`Output:      ${output}`);
  console.log(`Topics:      ${topics.length} topics`);
  console.log(`Brokers:     ${KAFKA_BROKERS.join(', ')}`);
  console.log('='.repeat(60));

  // Ensure output directory exists and is writable
  const outputDir = path.dirname(output);
  try {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
      console.log(`Created directory: ${outputDir}`);
    }
    // Verify directory is writable
    fs.accessSync(outputDir, fs.constants.W_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Cannot write to output directory '${outputDir}': ${message}`);
    process.exit(1);
  }

  // Initialize Kafka
  const kafka = new Kafka({
    clientId: 'omnidash-event-recorder',
    brokers: KAFKA_BROKERS,
  });

  const consumer: Consumer = kafka.consumer({
    groupId: `omnidash-recorder-${Date.now()}`, // Unique group to read from beginning
  });

  // Use counters instead of accumulating full events in memory
  let eventCount = 0;
  const topicCounts: Record<string, number> = {};
  const startTime = Date.now();
  const outputPath = path.resolve(output);

  // Create write stream for streaming events to disk
  const writeStream = fs.createWriteStream(outputPath, { flags: 'w', encoding: 'utf8' });

  // Track if shutdown has been initiated to prevent duplicate cleanup
  let isShuttingDown = false;

  // Promise that resolves when shutdown is complete
  let resolveShutdown: () => void;
  const shutdownComplete = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  // Cleanup function for graceful shutdown
  const shutdown = async (reason: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n\n${reason}`);

    // Close write stream
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Disconnect from Kafka
    await consumer.disconnect();
    console.log('Disconnected from Kafka');

    resolveShutdown();
  };

  try {
    await consumer.connect();
    console.log('Connected to Kafka');

    // Subscribe to all topics
    await consumer.subscribe({
      topics,
      fromBeginning: false, // Only record new events
    });

    console.log(`\nRecording started at ${new Date().toISOString()}`);
    console.log(`Will stop after ${duration} seconds or Ctrl+C\n`);

    // Set up duration timer BEFORE starting consumer (critical for proper shutdown)
    const durationTimer = setTimeout(() => {
      shutdown('Duration reached, stopping...').catch(console.error);
    }, duration * 1000);

    // Handle Ctrl+C gracefully - set up BEFORE starting consumer
    process.once('SIGINT', () => {
      clearTimeout(durationTimer);
      shutdown('Received SIGINT, stopping...').catch(console.error);
    });

    // Start message handler - do NOT await since consumer.run() doesn't resolve until stopped
    // The consumer processes messages in the background via the event loop
    consumer
      .run({
        eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
          // Skip processing if shutting down
          if (isShuttingDown) return;

          const now = Date.now();
          const relativeMs = now - startTime;

          let value: unknown;
          try {
            value = JSON.parse(message.value?.toString() || '{}');
          } catch {
            value = message.value?.toString() || '';
          }

          const event: RecordedEvent = {
            timestamp: new Date(now).toISOString(),
            relativeMs,
            topic,
            partition,
            offset: message.offset,
            key: message.key?.toString() || null,
            value,
          };

          // Stream event to disk instead of accumulating in memory
          writeStream.write(JSON.stringify(event) + '\n');

          // Update counters for stats
          eventCount++;
          topicCounts[topic] = (topicCounts[topic] || 0) + 1;

          // Progress indicator
          const elapsed = Math.floor(relativeMs / 1000);
          process.stdout.write(
            `\rRecorded: ${eventCount} events | Elapsed: ${elapsed}s / ${duration}s`
          );
        },
      })
      .catch((err) => {
        console.error('Consumer error:', err);
        clearTimeout(durationTimer);
        shutdown('Consumer error, stopping...').catch(console.error);
      });

    // Wait for shutdown to complete (triggered by timer or SIGINT)
    await shutdownComplete;
  } catch (err) {
    // Handle connection/subscription errors
    console.error('Recording setup failed:', err);
    await shutdown('Setup error, cleaning up...').catch(console.error);
    throw err;
  }

  // Print summary
  if (eventCount > 0) {
    // Get actual file size from disk
    const fileStats = fs.statSync(outputPath);
    const fileSizeKB = (fileStats.size / 1024).toFixed(2);

    console.log('\n' + '='.repeat(60));
    console.log('Recording Complete');
    console.log('='.repeat(60));
    console.log(`Events recorded: ${eventCount}`);
    console.log(`Duration:        ${Math.floor((Date.now() - startTime) / 1000)} seconds`);
    console.log(`File size:       ${fileSizeKB} KB`);
    console.log(`Output file:     ${outputPath}`);
    console.log('='.repeat(60));

    // Print topic breakdown from counters
    console.log('\nEvents by topic:');
    Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([topic, count]) => {
        console.log(`  ${topic}: ${count}`);
      });
  } else {
    console.log('\nNo events recorded. Make sure there is activity on the subscribed topics.');
  }
}

recordEvents().catch((err) => {
  console.error('Recording failed:', err);
  process.exit(1);
});
