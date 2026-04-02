/**
 * Comprehensive Service Health Checker
 * Tests all external service connections and provides diagnostic information
 */

import { tryGetIntelligenceDb, isDatabaseConfigured, getDatabaseError } from './storage';
import { sql } from 'drizzle-orm';
import { Kafka } from 'kafkajs';
import { resolveBrokers, getBrokerString } from './bus-config.js';

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
  const brokerStr = getBrokerString();

  // If no brokers configured, return down status with helpful message
  if (brokerStr === 'not configured') {
    return {
      service: 'Kafka/Redpanda',
      status: 'down',
      latencyMs: Date.now() - startTime,
      error: 'KAFKA_BOOTSTRAP_SERVERS environment variable not configured',
      details: {
        message:
          'Set KAFKA_BOOTSTRAP_SERVERS in .env file (e.g., KAFKA_BOOTSTRAP_SERVERS=localhost:19092)',
      },
    };
  }

  const brokers = resolveBrokers();

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
    const db = tryGetIntelligenceDb();
    if (!db) {
      return {
        service: 'Event Consumer',
        status: 'down',
        details: { message: 'Database not available for watermark check' },
      };
    }

    const watermarkRows = await db.execute(sql`
      SELECT projection_name, last_offset, updated_at
      FROM projection_watermarks
      ORDER BY updated_at DESC
      LIMIT 20
    `);
    const rows = Array.isArray(watermarkRows) ? watermarkRows : watermarkRows?.rows || [];
    const topicCount = rows.length;
    const mostRecent = (rows as any[])[0]?.updated_at;

    let status: 'up' | 'down' | 'warning' = 'down';
    if (topicCount >= 3 && mostRecent) {
      const ageMs = Date.now() - new Date(mostRecent).getTime();
      status = ageMs < 60_000 ? 'up' : 'warning';
    } else if (topicCount > 0) {
      status = 'warning';
    }

    return {
      service: 'Event Consumer',
      status,
      details: {
        source: 'projection_watermarks',
        topicCount,
        lastWatermark: mostRecent || null,
        checkedAt: new Date().toISOString(),
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
