/**
 * server/bus-config.ts
 *
 * Single broker resolution singleton for omnidash.
 * Resolves broker address exactly once with correct precedence and explicit mode.
 *
 * ─── AUDIT: Broker Resolution Callsites (Task 1 / OMN-4769) ───────────────────
 *
 * Catalogued 11 distinct broker resolution sites as of 2026-03-12.
 * All sites to be replaced by resolveBrokers() / getBrokerString() (Task 3).
 *
 * Callsite | File                                  | Line    | Precedence Order
 * ─────────┼───────────────────────────────────────┼─────────┼────────────────────────────────────────
 *   CS-01  | server/event-consumer.ts              | ~969    | KAFKA_BOOTSTRAP_SERVERS || KAFKA_BROKERS
 *   CS-02  | server/event-consumer.ts              | ~1082   | KAFKA_BOOTSTRAP_SERVERS || KAFKA_BROKERS
 *   CS-03  | server/intelligence-event-adapter.ts  | ~87     | KAFKA_BOOTSTRAP_SERVERS || KAFKA_BROKERS
 *   CS-04  | server/service-health.ts              | ~101    | KAFKA_BROKERS || KAFKA_BOOTSTRAP_SERVERS  ← LEGACY-FIRST
 *   CS-05  | server/read-model-consumer.ts         | ~323    | KAFKA_BROKERS || KAFKA_BOOTSTRAP_SERVERS  ← LEGACY-FIRST
 *   CS-06  | server/topic-catalog-manager.ts       | ~162    | KAFKA_BROKERS || KAFKA_BOOTSTRAP_SERVERS  ← LEGACY-FIRST
 *   CS-07  | server/event-bus-data-source.ts       | ~139    | KAFKA_BROKERS || KAFKA_BOOTSTRAP_SERVERS  ← LEGACY-FIRST
 *   CS-08  | server/event-bus-data-source.ts       | ~177    | KAFKA_BROKERS || KAFKA_BOOTSTRAP_SERVERS  ← LEGACY-FIRST
 *   CS-09  | server/index.ts                       | ~271    | KAFKA_BROKERS || KAFKA_BOOTSTRAP_SERVERS  ← LEGACY-FIRST (env guard)
 *   CS-10  | server/index.ts                       | ~288    | KAFKA_BROKERS || KAFKA_BOOTSTRAP_SERVERS  ← LEGACY-FIRST (env guard)
 *   CS-11  | server/index.ts                       | ~396    | KAFKA_BROKERS || KAFKA_BOOTSTRAP_SERVERS  ← LEGACY-FIRST (runtime-env API)
 *   CS-12  | server/test/mock-event-generator.ts   | ~169    | KAFKA_BROKERS || KAFKA_BOOTSTRAP_SERVERS  ← LEGACY-FIRST
 *
 * Precedence problem summary:
 *   - 3 sites use KAFKA_BOOTSTRAP_SERVERS-first (correct — standard var wins)
 *   - 9 sites use KAFKA_BROKERS-first (legacy — prevents KAFKA_BOOTSTRAP_SERVERS from taking effect)
 *   - No site reads KAFKA_BROKERS_LOCAL or KAFKA_CLOUD_BOOTSTRAP_SERVERS
 *   - No site is aware of BUS_MODE or cloud vs local distinction
 *
 * Correct precedence (implemented below in resolveBrokers()):
 *   KAFKA_BOOTSTRAP_SERVERS > KAFKA_BROKERS > (throw)
 *
 * Note: KAFKA_BROKERS is the omnidash-specific var set by dev.sh / npm run dev.
 *       KAFKA_BOOTSTRAP_SERVERS is the platform-wide standard (in ~/.omnibase/.env).
 *
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * Bus mode inferred from broker address port.
 * - 'local'   → port 19092 (local Docker Redpanda)
 * - 'cloud'   → port 29092 (cloud bus tunnel) # cloud-bus-ok OMN-4771
 * - 'unknown' → any other port
 */
export type BusMode = 'local' | 'cloud' | 'unknown';

/**
 * Infer bus mode from a broker string (single broker address or comma-separated list).
 * Uses the port of the first broker to determine mode.
 */
export function getBusMode(brokerString: string): BusMode {
  const firstBroker = brokerString.split(',')[0].trim();
  const portMatch = firstBroker.match(/:(\d+)$/);
  if (!portMatch) return 'unknown';
  const port = parseInt(portMatch[1], 10);
  if (port === 19092) return 'local';
  if (port === 29092) return 'cloud'; // # cloud-bus-ok OMN-4771
  return 'unknown';
}

/**
 * Resolve Kafka broker list from environment variables.
 *
 * Precedence: KAFKA_BOOTSTRAP_SERVERS > KAFKA_BROKERS
 *
 * Throws if neither is set — broker configuration is required infrastructure.
 * The error message always contains 'KAFKA_BOOTSTRAP_SERVERS' so callers can
 * detect the missing-config case reliably.
 */
export function resolveBrokers(): string[] {
  const brokerString = process.env.KAFKA_BOOTSTRAP_SERVERS ?? process.env.KAFKA_BROKERS;
  if (!brokerString) {
    throw new Error(
      'KAFKA_BOOTSTRAP_SERVERS (or KAFKA_BROKERS) environment variable is required. ' +
        'Set it in .env file or export it before starting the server. ' +
        'Example: KAFKA_BOOTSTRAP_SERVERS=localhost:19092'
    );
  }
  return brokerString
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
}

/**
 * Return the raw broker string (first-broker-wins, not split).
 * Returns 'not configured' instead of throwing when neither var is set.
 * Useful for logging and health-check endpoints.
 */
export function getBrokerString(): string {
  return process.env.KAFKA_BOOTSTRAP_SERVERS ?? process.env.KAFKA_BROKERS ?? 'not configured';
}

/**
 * Return the current bus mode inferred from resolved broker address.
 * Returns 'unknown' when brokers are not configured.
 */
export function getCurrentBusMode(): BusMode {
  return getBusMode(getBrokerString());
}
