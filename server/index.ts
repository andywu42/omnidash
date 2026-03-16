// Hard precedence order (all calls use override: false — earlier wins, no exceptions):
// 1. Shell env (highest) — set by scripts/dev.sh sourcing ~/.omnibase/.env,
//    or by ~/.zshrc at session start, or by K8s-injected vars in cloud
// 2. Local .env — service-specific non-secret defaults only
//    (PORT, KAFKA_CONSUMER_GROUP_ID, ENABLE_REAL_TIME_EVENTS, etc.)
// 3. ~/.omnibase/.env — platform shared config; fills only vars missing from 1 and 2
// Cloud containers: paths 2 and 3 don't exist; K8s-injected vars (path 1) are the only source.
import { config } from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';
config({ override: false });
config({ path: join(homedir(), '.omnibase', '.env'), override: false });

import { writeFileSync, unlinkSync } from 'fs';
const SERVER_PID_FILE = '.server.pid';

// Suppress KafkaJS partitioner warning
if (!process.env.KAFKAJS_NO_PARTITIONER_WARNING) {
  process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
}

import express, { type Request, Response, NextFunction } from 'express';
import { initOidcClient, isAuthEnabled } from './auth/oidc-client';
import { configureSession, getSessionMiddleware } from './auth/session-config';
import { authRoutes, authMeRoute } from './auth/auth-routes';
import { refreshTokenIfNeeded, requireAuth } from './auth/middleware';
import healthProbeRoutes from './health-probe-routes';
import { registerRoutes } from './routes';
import { setupVite, serveStatic, log } from './vite';
import { setupWebSocket } from './websocket';
import { DbBackedProjectionView } from './projections/db-backed-projection-view';
import { eventConsumer } from './event-consumer';
import { eventBusDataSource } from './event-bus-data-source';
import { eventBusMockGenerator } from './event-bus-mock-generator';
import { startMockRegistryEvents, stopMockRegistryEvents } from './registry-events';
import { runtimeIdentity } from './runtime-identity';
import { printStartupBanner } from './startup-banner.js';
import { getBrokerString } from './bus-config.js';
import { initProjectionListeners, teardownProjectionListeners } from './projection-instance';
import { wireProjectionSources, projectionService } from './projection-bootstrap';
import { NodeRegistryProjection } from './projections/node-registry-projection';
import { readModelConsumer } from './read-model-consumer';
import { runStartupBackfillIfEmpty } from './startup-backfill';
import { startCdqaGateWatcher } from './cdqa-gate-watcher';
import { startPipelineHealthWatcher, stopPipelineHealthWatcher } from './pipeline-health-watcher';
import { startEventBusHealthPoller, stopEventBusHealthPoller } from './event-bus-health-poller';
import { startWorkerHealthPoller, stopWorkerHealthPoller } from './worker-health-poller';
import selfTestRoutes, { runStartupSelfTest } from './startup-self-test';
import buildInfoRoutes from './build-info-routes';

const app = express();

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown;
  }
}
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: false }));

// Disable caching for all API routes to ensure fresh data
app.use('/api', (req, res, next) => {
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  // Remove any existing ETag headers to prevent 304 responses
  res.removeHeader('ETag');
  // Disable Express ETag generation
  res.setHeader('ETag', '');
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on('finish', () => {
    const duration = Date.now() - start;
    if (path.startsWith('/api')) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + '…';
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Print bus mode banner before any consumers start (OMN-4776)
  printStartupBanner();

  // Log runtime identity on startup (identity loaded from shared module)
  if (runtimeIdentity.supervised) {
    log(`Running under ONEX runtime: node_id=${runtimeIdentity.nodeId}`);
  } else {
    log(`Running in standalone mode (no runtime supervision)`);
  }

  // --------------------------------------------------------------------------
  // Authentication (OMN-3698)
  // OIDC discovery + session middleware + auth routes + auth gate.
  // When KEYCLOAK_ISSUER is unset, auth is disabled (dev mode).
  // When set, auth is fail-closed: discovery failure → process.exit(1).
  // --------------------------------------------------------------------------
  await initOidcClient();
  await configureSession(app);

  // Auth routes: /auth/login, /auth/callback, /auth/logout
  app.use('/auth', authRoutes);

  // /api/auth/me — returns auth status (BEFORE requireAuth gate)
  app.use('/api/auth', authMeRoute);

  // /api/health-probe — public aggregate health for k8s probes and top-bar
  // indicator (OMN-4515). Registered BEFORE the requireAuth gate so unauthenticated
  // callers (k8s liveness/readiness, frontend without session) can reach it.
  app.use('/api/health-probe', healthProbeRoutes);

  // /api/health/self-test — startup self-test report (OMN-4974).
  // Registered BEFORE the requireAuth gate so health checks can access it.
  app.use('/api/health', selfTestRoutes);

  // /api/build-info — version, git SHA, uptime for lifecycle scripts (OMN-5143).
  // Registered BEFORE the requireAuth gate so unauthenticated callers can reach it.
  app.use('/api/build-info', buildInfoRoutes);

  // Token refresh + auth gate for all /api routes (skip /api/auth/me and /api/health-probe)
  const skipPublicRoutes = (req: Request, _res: Response, next: NextFunction) => {
    if (
      req.originalUrl.startsWith('/api/auth/me') ||
      req.originalUrl.startsWith('/api/health-probe')
    )
      return next('route');
    next();
  };
  app.use('/api', skipPublicRoutes, refreshTokenIfNeeded);
  app.use('/api', skipPublicRoutes, requireAuth);

  // --------------------------------------------------------------------------
  // Node Registry Projection (OMN-2097)
  // Register into the shared ProjectionService singleton BEFORE routes are
  // registered so that projection REST endpoints are available immediately.
  // --------------------------------------------------------------------------
  const nodeRegistryView = new NodeRegistryProjection();
  if (!projectionService.getView(nodeRegistryView.viewId)) {
    projectionService.registerView(nodeRegistryView);
  }

  const server = await registerRoutes(app);

  // --------------------------------------------------------------------------
  // Bridge EventConsumer node events → ProjectionService (OMN-2097)
  // MUST be registered BEFORE eventConsumer.start() to avoid missing events.
  // --------------------------------------------------------------------------

  /** Safely parse createdAt into epoch-ms, returning undefined if invalid to let ProjectionService use its own extraction. */
  function extractBridgeTimestamp(event: Record<string, unknown>): number | undefined {
    const raw = event.createdAt;
    if (raw == null) return undefined;
    // Handle numeric timestamps (epoch-ms) directly; coerce everything else via Date parsing
    const ts = typeof raw === 'number' ? raw : new Date(String(raw)).getTime();
    return Number.isFinite(ts) ? ts : undefined;
  }

  const projectionBridgeListeners = {
    nodeIntrospectionUpdate: (event: Record<string, unknown>) => {
      projectionService.ingest({
        type: 'node-introspection',
        source: 'event-consumer',
        eventTimeMs: extractBridgeTimestamp(event),
        payload: event,
      });
    },
    nodeHeartbeatUpdate: (event: Record<string, unknown>) => {
      projectionService.ingest({
        type: 'node-heartbeat',
        source: 'event-consumer',
        eventTimeMs: extractBridgeTimestamp(event),
        payload: event,
      });
    },
    nodeStateChangeUpdate: (event: Record<string, unknown>) => {
      projectionService.ingest({
        type: 'node-state-change',
        source: 'event-consumer',
        eventTimeMs: extractBridgeTimestamp(event),
        payload: event,
      });
    },
    // OMN-5132: Bridge node-became-active events to the projection service
    // so NodeRegistryProjection.handleNodeBecameActive() transitions nodes to 'active'.
    nodeBecameActive: (event: Record<string, unknown>) => {
      projectionService.ingest({
        type: 'node-became-active',
        source: 'event-consumer',
        eventTimeMs: extractBridgeTimestamp(event),
        payload: event,
      });
    },
    // Canonical event handlers (handleCanonicalNode*) only emit 'nodeRegistryUpdate',
    // not the granular events above. Bridge the full registry snapshot as a seed event
    // so the projection stays in sync with canonical-path updates. The seed handler
    // uses sentinel-0 timestamps, so nodes already updated by a granular event with
    // a real timestamp will not be overwritten (merge tracker rejects stale updates).
    nodeRegistryUpdate: (registeredNodes: Record<string, unknown>[]) => {
      projectionService.ingest({
        type: 'node-registry-seed',
        source: 'event-consumer-canonical',
        payload: { nodes: registeredNodes },
      });
    },
  };
  eventConsumer.on('nodeIntrospectionUpdate', projectionBridgeListeners.nodeIntrospectionUpdate);
  eventConsumer.on('nodeHeartbeatUpdate', projectionBridgeListeners.nodeHeartbeatUpdate);
  eventConsumer.on('nodeStateChangeUpdate', projectionBridgeListeners.nodeStateChangeUpdate);
  eventConsumer.on('nodeBecameActive', projectionBridgeListeners.nodeBecameActive);
  eventConsumer.on('nodeRegistryUpdate', projectionBridgeListeners.nodeRegistryUpdate);

  // Wire intent-event → ProjectionService BEFORE consumer.start() so Phase A
  // historical events are captured by the projection (not dropped silently).
  initProjectionListeners();

  // Validate and start Kafka event consumer
  try {
    // First validate that Kafka broker is reachable
    const isKafkaAvailable = await eventConsumer.validateConnection();

    if (isKafkaAvailable) {
      await eventConsumer.start();
      log('✅ Event consumer started successfully - real-time events enabled');
    } else {
      log('⚠️  Kafka broker validation failed - continuing without real-time events');
      log('   Dashboard will use database queries only (slower, no live updates)');
    }
  } catch (error) {
    console.error('❌ Failed to start event consumer:', error);
    console.error('   Intelligence endpoints will not receive real-time data');
    console.error('   Application will continue with limited functionality');
  }

  // Validate and start Event Bus Data Source
  try {
    const isEventBusAvailable = await eventBusDataSource.validateConnection();

    if (isEventBusAvailable) {
      await eventBusDataSource.start();
      log('✅ Event Bus Data Source started successfully - event storage enabled');
    } else {
      log('⚠️  Event Bus Data Source validation failed - continuing without event storage');
      log('   Event querying will be limited to database queries');
    }
  } catch (error) {
    console.error('❌ Failed to start Event Bus Data Source:', error);
    console.error('   Event querying endpoints will not be available');
    console.error('   Application will continue with limited functionality');
  }

  // Start read-model consumer (OMN-2061)
  // Projects Kafka events into omnidash_analytics for durable persistence.
  // Runs as a separate consumer group from EventConsumer.
  //
  // Fire-and-forget intentionally: do NOT await this call.
  // With MAX_RETRY_ATTEMPTS=10 and exponential backoff up to 30 s, a Kafka
  // outage would delay server.listen() by over 5 minutes, causing the process
  // to appear unresponsive to health checks and load balancers. The read-model
  // consumer is non-critical for HTTP serving — the server must be up first.
  readModelConsumer
    .start()
    .then(() => {
      const stats = readModelConsumer.getStats();
      if (stats.isRunning) {
        log('✅ Read-model consumer started - projecting events to omnidash_analytics');
      } else {
        const hasEnvVars =
          getBrokerString() !== 'not configured' && !!process.env.OMNIDASH_ANALYTICS_DB_URL;
        if (hasEnvVars) {
          log(
            '⚠️  Read-model consumer failed to connect after max retries (Kafka connectivity issue)'
          );
          log('   Check that KAFKA_BROKERS is reachable and the broker is healthy');
        } else {
          log(
            '⚠️  Read-model consumer skipped (missing KAFKA_BROKERS or OMNIDASH_ANALYTICS_DB_URL)'
          );
        }
        log('   Read-model tables will not receive new projections');
      }
    })
    .catch((error) => {
      const hasEnvVars =
        getBrokerString() !== 'not configured' && !!process.env.OMNIDASH_ANALYTICS_DB_URL;
      if (hasEnvVars) {
        console.error(
          '❌ Read-model consumer failed after retries (Kafka connectivity issue):',
          error
        );
        console.error('   Check that KAFKA_BROKERS is reachable and the broker is healthy');
      } else {
        console.error(
          '❌ Failed to start read-model consumer (missing KAFKA_BROKERS or OMNIDASH_ANALYTICS_DB_URL):',
          error
        );
      }
      console.error('   Read-model tables will not receive new projections');
      console.error('   Application will continue with limited functionality');
    });

  // Wire projection event sources (after EventConsumer and EventBusDataSource are started)
  // This covers EventBusProjection wiring; NodeRegistry bridge listeners are above.
  let cleanupProjectionSources: (() => void) | undefined;
  try {
    cleanupProjectionSources = wireProjectionSources();
  } catch (error) {
    console.error('❌ Failed to wire projection sources:', error);
    console.error('   Projections will remain empty until next restart');
    console.error('   Application will continue with limited functionality');
  }

  // Start CDQA gate file watcher — polls ~/.claude/skill-results/*/cdqa-gate-log.json (OMN-3190)
  startCdqaGateWatcher();

  // Start pipeline health watcher — polls ~/.claude/pipelines/*/state.yaml (OMN-3192)
  startPipelineHealthWatcher();

  // Start event bus health poller — polls Redpanda Admin API (OMN-3192)
  startEventBusHealthPoller();

  // Start worker health poller — polls docker inspect for runtime containers (OMN-3598)
  startWorkerHealthPoller();

  // Backfill injection_effectiveness and latency_breakdowns from event_bus_events
  // if the tables are empty (OMN-2920). Fire-and-forget: non-fatal if it fails.
  runStartupBackfillIfEmpty().catch((err) => {
    console.error('[backfill] Startup backfill threw unexpectedly:', err);
  });

  // Seed projection with any nodes already tracked by EventConsumer from prior runs.
  // Seed has no eventTimeMs — represents in-memory EventConsumer state, not a
  // timestamped Kafka event. ProjectionService assigns sentinel (epoch 0), so
  // MonotonicMergeTracker accepts any future event with a real timestamp.
  //
  // NOTE: On a fresh start this will almost always return an empty array because
  // eventConsumer.start() triggers async Kafka consumer group rebalancing — the
  // consumer hasn't received messages yet. The seed path only provides value when
  // EventConsumer has cached nodes from a prior module load (e.g., hot-reload).
  // New nodes will arrive via the event bridge listeners registered above.
  const existingNodes = eventConsumer.getRegisteredNodes();
  if (existingNodes.length > 0) {
    projectionService.ingest({
      type: 'node-registry-seed',
      source: 'event-consumer',
      payload: { nodes: existingNodes },
    });
    log(`Seeded node-registry projection with ${existingNodes.length} existing nodes`);
  }

  // Setup WebSocket for real-time events
  if (process.env.ENABLE_REAL_TIME_EVENTS === 'true') {
    setupWebSocket(server);
  }

  // Demo mode: start ALL mock data generators (fake heartbeats, events, registry)
  // ONLY runs when DEMO_MODE=true is explicitly set — no fake data by default
  const isDemoMode =
    process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'test' && !process.env.VITEST;

  if (isDemoMode) {
    log('🎭 DEMO MODE enabled — starting mock data generators');

    // Mock event bus generator (fake Kafka event chains)
    try {
      await eventBusDataSource.initializeSchema();
      await eventBusMockGenerator.start({
        continuous: true,
        interval_ms: 5000,
        initialChains: 20,
      });
      log('✅ Mock event generator started');
    } catch (mockError) {
      console.error('❌ Failed to start mock event generator:', mockError);
    }

    // Mock registry events (fake heartbeats, state changes)
    if (process.env.ENABLE_REAL_TIME_EVENTS === 'true') {
      const parsedInterval = parseInt(process.env.MOCK_REGISTRY_EVENT_INTERVAL || '5000', 10);
      const mockInterval =
        !Number.isFinite(parsedInterval) || parsedInterval < 1000 ? 5000 : parsedInterval;
      startMockRegistryEvents(mockInterval);
      log(`✅ Mock registry events started (interval: ${mockInterval}ms)`);
    }
  }

  // Internal-only: bus/environment identity for omnidash header badge
  // Not intended for public internet exposure. Contains broker topology info (non-secret).
  app.get('/api/runtime-environment', (_req, res) => {
    // Use bus-config singleton for consistent broker resolution (OMN-4774)
    const brokers = getBrokerString();
    res.json({
      busId: process.env.BUS_ID || 'unknown',
      kafkaBrokers: brokers === 'not configured' ? 'unknown' : brokers,
      namespace: process.env.K8S_NAMESPACE || 'local',
    });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal Server Error';

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get('env') === 'development') {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 3000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '3000', 10);
  server.listen(port, '0.0.0.0', () => {
    log(`serving on port ${port}`);
    // Write PID file only after the server is successfully listening so that
    // a startup failure never leaves a stale PID for kill-server.sh to chase.
    try {
      writeFileSync(SERVER_PID_FILE, String(process.pid), 'utf-8');
    } catch {
      // Non-fatal: PID file is a best-effort cleanup aid
    }

    // OMN-4958: Warm all DB-backed projection views so the first API request
    // returns real data instead of emptyPayload(). Fire-and-forget — warm-up
    // failures are logged but must not block the server.
    // OMN-4974: After warm-up, run the startup self-test to report data source status.
    DbBackedProjectionView.warmAll()
      .then(() => runStartupSelfTest())
      .catch((err) => {
        console.error('[startup] warmAll/self-test failed:', err);
      });
  });

  // Graceful shutdown
  const cleanupProjectionBridge = () => {
    eventConsumer.removeListener(
      'nodeIntrospectionUpdate',
      projectionBridgeListeners.nodeIntrospectionUpdate
    );
    eventConsumer.removeListener(
      'nodeHeartbeatUpdate',
      projectionBridgeListeners.nodeHeartbeatUpdate
    );
    eventConsumer.removeListener(
      'nodeStateChangeUpdate',
      projectionBridgeListeners.nodeStateChangeUpdate
    );
    eventConsumer.removeListener(
      'nodeRegistryUpdate',
      projectionBridgeListeners.nodeRegistryUpdate
    );
  };

  process.on('SIGTERM', async () => {
    log('SIGTERM received, shutting down gracefully');
    try {
      unlinkSync(SERVER_PID_FILE);
    } catch {
      /* already gone */
    }
    teardownProjectionListeners();
    cleanupProjectionBridge();
    cleanupProjectionSources?.();
    await readModelConsumer.stop();
    await eventConsumer.stop();
    await eventBusDataSource.stop();
    eventBusMockGenerator.stop();
    stopMockRegistryEvents();
    stopPipelineHealthWatcher();
    stopEventBusHealthPoller();
    stopWorkerHealthPoller();
    server.close(() => {
      log('Server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', async () => {
    log('SIGINT received, shutting down gracefully');
    try {
      unlinkSync(SERVER_PID_FILE);
    } catch {
      /* already gone */
    }
    teardownProjectionListeners();
    cleanupProjectionBridge();
    cleanupProjectionSources?.();
    await readModelConsumer.stop();
    await eventConsumer.stop();
    await eventBusDataSource.stop();
    eventBusMockGenerator.stop();
    stopMockRegistryEvents();
    stopPipelineHealthWatcher();
    stopEventBusHealthPoller();
    stopWorkerHealthPoller();
    server.close(() => {
      log('Server closed');
      process.exit(0);
    });
  });
})();
