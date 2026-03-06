/**
 * Comprehensive Service Health Checker
 * Tests all external service connections and provides diagnostic information
 */

import { tryGetIntelligenceDb, isDatabaseConfigured, getDatabaseError } from './storage';
import { sql } from 'drizzle-orm';
import { eventConsumer } from './event-consumer';
import { Kafka } from 'kafkajs';

export interface ServiceHealthCheck {
  service: string;
  status: 'up' | 'down' | 'warning';
  latencyMs?: number;
  error?: string;
  details?: Record<string, any>;
}

export async function checkAllServices(): Promise<ServiceHealthCheck[]> {
  const checks: ServiceHealthCheck[] = [];

  // 1. PostgreSQL Database Check
  checks.push(await checkPostgreSQL());

  // 2. Kafka/Redpanda Check
  checks.push(await checkKafka());

  // 3. Event Consumer Check
  checks.push(await checkEventConsumer());

  // 4. Keycloak/OIDC Check
  checks.push(await checkKeycloak());

  return checks;
}

async function checkPostgreSQL(): Promise<ServiceHealthCheck> {
  const startTime = Date.now();

  // Check if database is configured first (graceful degradation)
  if (!isDatabaseConfigured()) {
    return {
      service: 'PostgreSQL',
      status: 'down',
      latencyMs: 0,
      error: getDatabaseError() || 'Database not configured',
      details: {
        configured: false,
        message:
          'Dashboard running in demo-only mode. Set POSTGRES_* environment variables to enable database.',
      },
    };
  }

  try {
    const db = tryGetIntelligenceDb();
    if (!db) {
      return {
        service: 'PostgreSQL',
        status: 'down',
        latencyMs: 0,
        error: 'Database connection not available',
      };
    }

    const result = await db.execute(
      sql`SELECT 1 as check, NOW() as current_time, version() as pg_version`
    );
    const latency = Date.now() - startTime;

    // Parse result (handle different return types)
    const rows = Array.isArray(result) ? result : result?.rows || result || [];
    const firstRow = rows[0] || {};

    return {
      service: 'PostgreSQL',
      status: latency < 1000 ? 'up' : 'warning',
      latencyMs: latency,
      details: {
        configured: true,
        version: firstRow.pg_version?.substring(0, 50) || 'unknown',
        currentTime: firstRow.current_time,
      },
    };
  } catch (error) {
    return {
      service: 'PostgreSQL',
      status: 'down',
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
      details: {
        configured: true,
        message: 'Database configured but connection failed. Check network/credentials.',
      },
    };
  }
}

async function checkKafka(): Promise<ServiceHealthCheck> {
  const startTime = Date.now();
  const brokersEnv = process.env.KAFKA_BROKERS || process.env.KAFKA_BOOTSTRAP_SERVERS;

  // If no brokers configured, return down status with helpful message
  if (!brokersEnv) {
    return {
      service: 'Kafka/Redpanda',
      status: 'down',
      latencyMs: Date.now() - startTime,
      error: 'KAFKA_BROKERS or KAFKA_BOOTSTRAP_SERVERS environment variable not configured',
      details: {
        message: 'Set KAFKA_BROKERS in .env file (e.g., KAFKA_BROKERS=host:port)',
      },
    };
  }

  const brokers = brokersEnv.split(',');

  try {
    // Create a test Kafka client
    const kafka = new Kafka({
      brokers,
      clientId: 'omnidash-health-check',
      connectionTimeout: 3000,
      requestTimeout: 3000,
    });

    // Try to connect (simple connection test)
    const admin = kafka.admin();
    await admin.connect();
    const latency = Date.now() - startTime;

    // Try to list topics to verify full connectivity
    try {
      const topics = await admin.listTopics();
      await admin.disconnect();

      return {
        service: 'Kafka/Redpanda',
        status: 'up',
        latencyMs: latency,
        details: {
          brokers: brokers,
          topicCount: topics.length,
        },
      };
    } catch {
      await admin.disconnect();
      // Connection worked but listing failed - still consider it up
      return {
        service: 'Kafka/Redpanda',
        status: 'up',
        latencyMs: latency,
        details: {
          brokers: brokers,
          note: 'Connected but topic listing failed',
        },
      };
    }
  } catch (error) {
    const latency = Date.now() - startTime;
    return {
      service: 'Kafka/Redpanda',
      status: 'down',
      latencyMs: latency,
      error: error instanceof Error ? error.message : 'Unknown error',
      details: {
        brokers: brokers,
      },
    };
  }
}

async function checkKeycloak(): Promise<ServiceHealthCheck> {
  const issuerUrl = process.env.KEYCLOAK_ISSUER;

  if (!issuerUrl) {
    return {
      service: 'Keycloak',
      status: 'down',
      details: {
        configured: false,
        message: 'KEYCLOAK_ISSUER not set -- auth disabled (dev mode)',
      },
    };
  }

  const startTime = Date.now();
  const discoveryUrl = `${issuerUrl}/.well-known/openid-configuration`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(discoveryUrl, { signal: controller.signal });
    clearTimeout(timeout);

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      return {
        service: 'Keycloak',
        status: 'down',
        latencyMs,
        error: `OIDC discovery returned HTTP ${response.status}`,
        details: { configured: true },
      };
    }

    const config = (await response.json()) as Record<string, unknown>;

    return {
      service: 'Keycloak',
      status: 'up',
      latencyMs,
      details: {
        configured: true,
        issuer: config.issuer,
      },
    };
  } catch (error) {
    return {
      service: 'Keycloak',
      status: 'down',
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
      details: { configured: true },
    };
  }
}

async function checkEventConsumer(): Promise<ServiceHealthCheck> {
  try {
    const health = eventConsumer.getHealthStatus();

    return {
      service: 'Event Consumer',
      status: health.status === 'healthy' ? 'up' : 'down',
      details: {
        isRunning: eventConsumer['isRunning'] || false,
        eventsProcessed: health.eventsProcessed || 0,
        recentActionsCount: health.recentActionsCount || 0,
      },
    };
  } catch (error) {
    return {
      service: 'Event Consumer',
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
