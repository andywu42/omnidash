# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Shared Standards**: See **`~/.claude/CLAUDE.md`** for:
> - Shared development standards (Git, testing, architecture)
> - Environment configuration priority rules
> - Infrastructure topology (PostgreSQL, Kafka/Redpanda, remote server, Docker networking)
> - Environment variables and LLM architecture
>
> This file contains **omnidash-specific** frontend architecture and development only.

## Omnidash-Specific Configuration

Key values specific to this repository (all sourced from `.env`):

- **Port**: 3000 (set in package.json: `PORT=3000 npm run dev`) -- NOT 5000
- **Kafka Brokers**: sourced from `.env` (`KAFKA_BROKERS`)
- **Read-Model DB**: `omnidash_analytics` (omnidash's own read-model database)
- **Database credentials**: Always sourced from `.env` — never hardcode passwords

## Common Commands

**Development**:

```bash
PORT=3000 npm run dev  # Start development server (port 3000)
npm run check          # TypeScript type checking across client/server/shared
npm run build          # Build frontend (Vite) and backend (esbuild) for production
PORT=3000 npm start    # Run production build on port 3000
```

**Testing**:

```bash
npm run test              # Run vitest tests
npm run test:ui           # Run tests with interactive UI
npm run test:coverage     # Generate test coverage report
```

**Database**:

```bash
npm run db:migrate        # Run SQL migrations from migrations/ (canonical)
npm run db:check-parity   # Verify migration state matches disk
npm run db:check-coupling # Detect schema changes missing a migration
```

> **SQL-first migration rule (OMN-3750)**: SQL migrations in `migrations/` are the
> single source of truth for the `omnidash_analytics` schema. Drizzle schema
> definitions in `shared/intelligence-schema.ts` are the ORM layer that MUST match
> the migrations -- never the other way around. `db:push` is disabled; use
> `db:migrate` instead. When adding a new table or altering a column:
>
> 1. Write a new `migrations/NNNN_description.sql` file
> 2. Add/update the Drizzle `pgTable()` definition in `shared/intelligence-schema.ts`
> 3. Run `npm run db:migrate` to apply
> 4. Run `npm run db:check-parity` to verify

**Testing APIs**:

```bash
# Use port 3000, not 5000!
curl http://localhost:3000/api/intelligence/patterns/summary
curl http://localhost:3000/api/intelligence/agents/summary
curl http://localhost:3000/api/intelligence/events/recent
curl http://localhost:3000/api/intelligence/routing/metrics
curl http://localhost:3000/api/intelligence/quality/summary
```

**Observability & Testing**:

```bash
# Event generation and testing
npm run seed-events              # Seed test events once
npm run seed-events:continuous   # Continuous event seeding for testing
npm run check-topics             # Check Kafka topic health and consumer lag

# Manual event testing
node scripts/seed-events.ts      # Direct script execution
```

**Prometheus Metrics** (OMN-4609, OMN-4598):

```bash
# Prometheus-compatible /metrics endpoint — no auth required
curl http://localhost:3000/metrics
# Exposes: omnidash_data_sources_live_count, _mock_count, _error_count, _offline_count
# PrometheusRule OmnidashDataSourceHealthBelowThreshold alerts when live_count < 11
# See: server/metrics-routes.ts, omninode_infra/k8s/onex-dev/runtime/prometheusrule-omnidash-health.yaml
```

**Health Regression Prevention** (OMN-4598, 2026-03-11):
- Root cause of OMN-4383: `BUS_ID` missing from omnidash Deployment → fixed via `envFrom: onex-runtime-config` (OMN-4606)
- Prevention plan: `omni_home/docs/plans/2026-03-11-dashboard-health-regression-prevention.md`
- Kafka topic preflight: `omninode_infra/scripts/verify-kafka-topics.sh` (OMN-4610)
- Topic manifest: `omninode_infra/k8s/onex-dev/runtime/required-kafka-topics.yaml`
- Post-deploy CI gate: `omninode_infra/.github/workflows/deploy-onex-dev.yml` (health check step)

**Dashboard URLs** (always port 3000):

Category Dashboards (default):
- Speed: http://localhost:3000/category/speed
- Success: http://localhost:3000/category/success
- Intelligence: http://localhost:3000/category/intelligence
- System Health: http://localhost:3000/category/health

Advanced Pages:
- Event Stream: http://localhost:3000/events
- Live Event Stream (investor demo): http://localhost:3000/live-events
- Pipeline Metrics: http://localhost:3000/extraction
- Injection Performance: http://localhost:3000/effectiveness
- Injection Latency: http://localhost:3000/effectiveness/latency
- Injection Utilization: http://localhost:3000/effectiveness/utilization
- Injection A/B Comparison: http://localhost:3000/effectiveness/ab
- Execution Graph: http://localhost:3000/graph
- Cost Trends: http://localhost:3000/cost-trends
- Intent Signals: http://localhost:3000/intents
- Pattern Intelligence: http://localhost:3000/patterns
- Pattern Enforcement: http://localhost:3000/enforcement
- Context Enrichment: http://localhost:3000/enrichment
- LLM Routing Effectiveness: http://localhost:3000/llm-routing
- Node Registry: http://localhost:3000/registry
- Registry Discovery: http://localhost:3000/discovery
- Validation: http://localhost:3000/validation
- Baselines & ROI: http://localhost:3000/baselines
- Correlation Trace: http://localhost:3000/trace
- Learned Insights: http://localhost:3000/insights
- Widget Showcase: http://localhost:3000/showcase

**Environment**: Always verify `.env` before assuming defaults (see `~/.claude/CLAUDE.md` for full configuration priority rules). Omnidash runs on `PORT=3000` (configured in package.json dev script).

## Project Architecture

### Monorepo Structure

Three-directory monorepo with TypeScript path aliases:

- **`client/`** → React frontend (accessed via `@/` alias)
- **`server/`** → Express backend (minimal API surface)
- **`shared/`** → Shared types/schemas (accessed via `@shared/` alias)

### Frontend Architecture

**Router Pattern**: Wouter-based SPA with dashboard routes. Default nav shows 4 category dashboards; granular drill-down pages live in a collapsible **Advanced** section (OMN-2182).

| Section | Group | Route | Component | Purpose |
| ------- | ----- | ----- | --------- | ------- |
| **Dashboards** | | `/category/speed` | SpeedCategory | Cache hit rate, latency percentiles, pipeline health |
| **Dashboards** | | `/category/success` | SuccessCategory | A/B comparison, injection hit rates, effectiveness trends |
| **Dashboards** | | `/category/intelligence` | IntelligenceCategory | Pattern utilization, intent classification, behavior tracking |
| **Dashboards** | | `/category/health` | SystemHealthCategory | Validation counts, node registry, health checks |
| **Advanced** | Monitoring | `/events` (+ `/`) | EventBusMonitor | Real-time Kafka event stream visualization |
| **Advanced** | Monitoring | `/live-events` | LiveEventStream | Investor-demo real-time Kafka event stream with pause/resume (OMN-1405) |
| **Advanced** | Monitoring | `/extraction` | ExtractionDashboard | Pattern extraction metrics and pipeline health |
| **Advanced** | Monitoring | `/effectiveness` | EffectivenessSummary | Injection effectiveness metrics and A/B analysis |
| **Advanced** | Monitoring | `/effectiveness/latency` | EffectivenessLatency | Latency breakdown, P50/P95/P99 comparison, cache hit rate (OMN-1891) |
| **Advanced** | Monitoring | `/effectiveness/utilization` | EffectivenessUtilization | Utilization distribution histogram and per-method median scores (OMN-1891) |
| **Advanced** | Monitoring | `/effectiveness/ab` | EffectivenessAB | Treatment vs control cohort A/B comparison for injection effectiveness (OMN-1891) |
| **Advanced** | Monitoring | `/graph` | ExecutionGraph | Live ONEX node execution graph with real-time data flow (OMN-1406, OMN-2302) |
| **Advanced** | Monitoring | `/cost-trends` | CostTrendDashboard | LLM cost trends, budget alerts, token usage |
| **Advanced** | Intelligence | `/intents` | IntentDashboard | Real-time intent classification and analysis |
| **Advanced** | Intelligence | `/patterns` | PatternLearning | Code pattern discovery and learning analytics |
| **Advanced** | Intelligence | `/enforcement` | PatternEnforcement | Enforcement hit rate, violations, and correction rate |
| **Advanced** | Intelligence | `/enrichment` | ContextEnrichmentDashboard | Hit rate per channel, token savings, latency distribution (OMN-2280) |
| **Advanced** | Intelligence | `/llm-routing` | LlmRoutingDashboard | LLM vs fuzzy routing agreement rate, latency, cost per decision (OMN-2279) |
| **Advanced** | System | `/registry` | NodeRegistry | Contract-driven node and service discovery |
| **Advanced** | System | `/discovery` | RegistryDiscovery | Live service instance discovery with filtering and node detail panel (OMN-1278) |
| **Advanced** | System | `/validation` | ValidationDashboard | Cross-repo validation runs and violation trends |
| **Advanced** | System | `/baselines` | BaselinesROI | Token/time delta, retry counts, and promotion recommendations for A/B patterns (OMN-2156) |
| **Advanced** | Tools | `/trace` | CorrelationTrace | Trace events by correlation ID |
| **Advanced** | Tools | `/insights` | LearnedInsights | Patterns and conventions from OmniClaude sessions |
| **Advanced** | Preview | `/showcase` | WidgetShowcase | All 5 contract-driven widget types |

**Component System**: Built on shadcn/ui (New York variant) with Radix UI primitives. All UI components live in `client/src/components/ui/` and follow shadcn conventions.

**Design Philosophy**: Carbon Design System principles (IBM) optimized for data-dense enterprise dashboards:

- Information density over white space
- IBM Plex Sans/Mono typography (loaded from Google Fonts)
- Scanability for real-time monitoring scenarios
- Consistent metric card patterns across dashboards

**State Management**:

- Server state: TanStack Query v5 (`queryClient` in `client/src/lib/queryClient.ts`)
- Theme state: Custom `ThemeProvider` context (supports dark/light modes, defaults to dark)
- Local state: React hooks

**Layout Pattern**: All dashboards share consistent structure:

```
<SidebarProvider>
  <AppSidebar /> (w-64, collapsible navigation)
  <Header /> (h-16, logo + system status + theme toggle)
  <Main /> (Dashboard-specific grid layouts)
```

### Backend Architecture

**API-Driven Design**: Express server provides comprehensive API endpoints for intelligence data with real-time WebSocket updates.

**Development vs Production**:

- **Dev**: Vite middleware integrated into Express for HMR (`setupVite()` in `server/vite.ts`)
- **Prod**: Static files served from `dist/public`, API routes from `dist/index.js`

**Build Process**:

1. Frontend: Vite bundles to `dist/public/`
2. Backend: esbuild bundles server to `dist/` (ESM format, platform: node, externalized packages)

**Backend Components**:

- `server/index.ts` - Main Express server with middleware setup
- `server/routes.ts` - Route registration and HTTP server creation
- `server/intelligence-routes.ts` - Intelligence API endpoints (100+ routes)
- `server/savings-routes.ts` - Compute/token savings tracking
- `server/agent-registry-routes.ts` - Agent discovery and management
- `server/alert-routes.ts` - Alert management system
- `server/websocket.ts` - WebSocket server with subscription management
- `server/event-consumer.ts` - Kafka consumer with event aggregation
- `server/db-adapter.ts` - PostgreSQL connection pooling and queries
- `server/service-health.ts` - Service health monitoring

**Database Layer**:

- **ORM**: Drizzle with Neon serverless PostgreSQL driver
- **Schemas**:
  - `shared/schema.ts` - User authentication tables
  - `shared/intelligence-schema.ts` - 30+ intelligence tracking tables
- **Type Safety**: Zod schemas auto-generated from Drizzle via `drizzle-zod`
- **Connection**: Two databases - app DB and read-model DB (`omnidash_analytics`, populated by Kafka consumer projections from upstream services)

**Request Logging**: Custom middleware logs API requests (`/api` paths only) with duration and truncated JSON responses (80 char limit). WebSocket connections logged separately.

### Key Architectural Patterns

**Mock Data Strategy**: Dashboards currently generate client-side mock data. Future production implementation should replace with:

- WebSocket or Server-Sent Events for real-time updates
- Actual API endpoints in `server/routes.ts`
- Backend data aggregation for metrics

**Path Alias Resolution**: Two import aliases configured in `tsconfig.json`, `vite.config.ts`, and `vitest.config.ts`:

```typescript
@/          → client/src/
@shared/    → shared/
```

Note: The `@assets/` alias exists in vite.config but is not widely used.

**Type Flow**: Database schema → Drizzle inferred types → Zod schemas → Runtime validation

```typescript
// shared/schema.ts
export const users = pgTable("users", { ... });
export type User = typeof users.$inferSelect;           // Drizzle inference
export const insertUserSchema = createInsertSchema(users); // Zod schema
```

**Component Reuse Philosophy**: MetricCard, ChartContainer, and StatusBadge are designed as reusable primitives across all dashboard pages. When adding new metrics or visualizations, extend these components rather than creating new patterns.

**Responsive Grid System**: Dashboards use Tailwind's responsive grid utilities with breakpoints:

- Mobile: 1-2 columns
- Tablet (md): 2-4 columns
- Desktop (xl/2xl): 4-6 columns (depending on dashboard)

**Theme Implementation**: CSS custom properties defined in `client/src/index.css` with separate tokens for light/dark modes. ThemeProvider switches between `.light` and `.dark` class on document root.

### Real-Time Event System

**WebSocket Architecture** (`server/websocket.ts`):

- WebSocket server mounted at `/ws` endpoint
- Client subscription model: clients subscribe to specific event types
- Heartbeat monitoring with 30-second intervals and missed ping tolerance
- Graceful connection management and cleanup

**Event Consumer** (`server/event-consumer.ts`):

- Kafka consumer using `kafkajs` library
- Connects to the broker configured via `KAFKA_BROKERS` in `.env`
- Consumes from multiple topics: `agent-routing-decisions`, `agent-transformation-events`, `router-performance-metrics`, `agent-actions`
- In-memory event aggregation and caching
- Provides aggregated metrics via `getAggregatedMetrics()` method
- EventEmitter-based pub/sub for internal event distribution

**Client Integration Pattern**:

```typescript
// Connect to WebSocket
const ws = new WebSocket('ws://localhost:3000/ws');

// Subscribe to events
ws.send(
  JSON.stringify({
    type: 'subscribe',
    topics: ['agent-actions', 'routing-decisions'],
  })
);

// Receive events
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Handle real-time updates
};
```

## Important Constraints

**Port Binding**: Application MUST run on the port specified in `PORT` environment variable (default 3000). Other ports are firewalled in deployment environment.

**Database Requirement**: Application expects `DATABASE_URL` environment variable. Server will fail to start if not provided (validated in `drizzle.config.ts`).

**Test Framework**: Vitest is configured with 20+ test files covering components and data sources.

**Test Configuration** (`vitest.config.ts`):

- Environment: jsdom (for DOM testing)
- Setup file: `client/src/tests/setup.ts`
- Coverage: v8 provider with text/json/html reporters
- Path aliases: Same as main tsconfig (`@/` and `@shared/`)

**Test Structure**:

- Component tests: `client/src/components/__tests__/` (12+ files)
  - MetricCard, DataTable, EventFeed, StatusLegend, etc.
- Data source tests: `client/src/lib/data-sources/__tests__/` (8+ files)
  - Tests for each dashboard's data fetching logic
- Testing tools: @testing-library/react, @testing-library/user-event, vitest

**Replit-Specific Plugins**: Development build includes Replit-specific Vite plugins (`@replit/vite-plugin-*`) only when `REPL_ID` environment variable is present. These are skipped in non-Replit environments.

## Intelligence Infrastructure Integration

**Current State**: Hybrid implementation with real-time capabilities already in place.

**Already Implemented**:

- **WebSocket Server**: `server/websocket.ts` provides real-time event streaming to clients
- **Kafka Consumer**: `server/event-consumer.ts` consumes events from Kafka topics
- **Database Adapter**: `server/db-adapter.ts` reads from PostgreSQL intelligence database
- **Intelligence Schema**: `shared/intelligence-schema.ts` defines 30+ tables for agent observability
- **API Routes**: Multiple route files serve intelligence data:
  - `server/intelligence-routes.ts` - Main intelligence API endpoints
  - `server/savings-routes.ts` - Compute/token savings tracking
  - `server/agent-registry-routes.ts` - Agent discovery and management
  - `server/alert-routes.ts` - Alert management

**In Progress**: Converting dashboard components from mock data to real API endpoints and WebSocket subscriptions.

### Available Data Sources

**Omnidash Read-Model Database** (`omnidash_analytics`):

- **Database**: `omnidash_analytics` (omnidash's own read-model database)
- Populated by `server/read-model-consumer.ts` which projects Kafka events into local tables
- **Key projected tables**:
  - `agent_routing_decisions` - Agent selection with confidence scoring
  - `agent_actions` - Tool calls, decisions, errors
  - `agent_transformation_events` - Polymorphic agent transformations
  - `projection_watermarks` - Consumer progress tracking

**Kafka Event Bus** (broker configured via `KAFKA_BROKERS` in `.env`):

- **Real-time event streaming** with <100ms latency
- **Topics**: `agent-routing-decisions`, `agent-transformation-events`, `router-performance-metrics`, `agent-actions`
- **Consumer Group**: `omnidash-consumers-v2`
- **Retention**: 3-7 days depending on topic

### Environment Variables

Add to `.env` for intelligence integration (see `.env.example` for template):

```bash
# Omnidash Read-Model Database (omnidash's own database)
# See .env file for actual credentials - NEVER commit passwords to git!
OMNIDASH_ANALYTICS_DB_URL="postgresql://postgres:<password>@localhost:5436/omnidash_analytics"

# Kafka Event Streaming (source of events projected into omnidash_analytics)
KAFKA_BROKERS=localhost:29092
KAFKA_CLIENT_ID=omnidash-dashboard
KAFKA_CONSUMER_GROUP=omnidash-consumers-v2

# Feature Flags
ENABLE_REAL_TIME_EVENTS=true
```

### Integration Patterns

**Pattern 1: Database-Backed API Endpoints** (✅ Implemented)

- Express API endpoints in `server/intelligence-routes.ts`, `server/savings-routes.ts`, `server/agent-registry-routes.ts`
- Uses Drizzle ORM with the local `omnidash_analytics` read-model database
- Data is projected from Kafka events by `server/read-model-consumer.ts`
- Backend aggregation and caching for performance
- Integrate with TanStack Query in dashboard components

**Pattern 2: WebSocket for Real-Time Updates** (✅ Implemented)

- WebSocket server at `/ws` in `server/websocket.ts`
- Consumes Kafka topics via `server/event-consumer.ts`
- Broadcasts events to subscribed clients (<100ms latency)
- Client subscription model for targeted updates

**Pattern 3: Server-Sent Events (SSE)** (Alternative Option)

- Simpler than WebSocket for one-way real-time updates
- Built-in browser reconnection
- Can be implemented as Express route streaming Kafka events

### Database Schema for Intelligence

Intelligence schema is defined in `shared/intelligence-schema.ts` with 30+ tables including:

**Core Tables** (already implemented):

- `agent_routing_decisions` - Agent selection with confidence scoring
- `agent_actions` - Tool calls, decisions, errors, successes
- `agent_transformation_events` - Polymorphic agent transformations
- `agent_manifest_injections` - Manifest generation and pattern discovery
- `workflow_steps` - Multi-step workflow execution tracking
- `llm_calls` - LLM API calls with token usage and costs
- `error_events` / `success_events` - Execution outcomes
- `debug_intelligence_entries` - Debug information capture
- `performance_metrics` - System performance tracking

All tables use Drizzle ORM with Zod validation schemas auto-generated via `createInsertSchema()`.

### Implementation Status

**✅ Phase 1: Infrastructure (Completed)**

- Intelligence schema with 30+ tables in `shared/intelligence-schema.ts`
- Database adapter in `server/db-adapter.ts` with connection pooling
- API endpoints in `server/intelligence-routes.ts` and related route files
- KafkaJS consumer in `server/event-consumer.ts` with event aggregation

**✅ Phase 2: Real-Time Streaming (Completed)**

- WebSocket server in `server/websocket.ts` with heartbeat monitoring
- Client subscription model for targeted event delivery
- Event bus integration with <100ms latency
- Automatic reconnection and error recovery

**🚧 Phase 3: Dashboard Integration (In Progress)**

1. Convert dashboard components from mock data to real API calls
2. Add `useWebSocket` hooks for real-time updates
3. Implement live metric updates with smooth animations
4. Add error boundaries and fallback states

**📋 Phase 4: Advanced Features (Planned)**

1. Qdrant integration for pattern similarity search
2. Redis caching layer for expensive queries
3. Materialized views for dashboard aggregations
4. D3.js visualizations for complex data relationships

### Dashboard-Specific Data Mappings

**EventBusMonitor** (`/events`) → Kafka consumer lag metrics, direct topic monitoring, topic: `agent-actions`
**ExtractionDashboard** (`/extraction`) → `agent_manifest_injections`, pattern data, pipeline health metrics
**EffectivenessSummary** (`/effectiveness`) → `agent_manifest_injections`, `llm_calls`, A/B analysis
**IntentDashboard** (`/intents`) → intent classification data, real-time signal analysis
**PatternLearning** (`/patterns`) → `agent_manifest_injections`, pattern data, learning analytics
**NodeRegistry** (`/registry`) → `agent_routing_decisions`, `agent_actions`, service discovery
**ValidationDashboard** (`/validation`) → `error_events`, validation runs, violation trends
**CorrelationTrace** (`/trace`) → `workflow_steps`, correlation data, event tracing
**LearnedInsights** (`/insights`) → `agent_routing_decisions`, `workflow_steps`, session patterns
**WidgetShowcase** (`/showcase`) → preview/demo data (contract-driven widget types)

### Complete Integration Guide

See `docs/architecture/OVERVIEW.md` for system architecture, `docs/architecture/READ_MODEL_PROJECTION_ARCHITECTURE.md` for projection details, and `docs/reference/API_ENDPOINT_CATALOG.md` for all endpoint documentation.

## Design System Reference

See `design_guidelines.md` for comprehensive Carbon Design System implementation details including:

- Typography scale and IBM Plex font usage
- Spacing primitives (Tailwind units: 2, 4, 6, 8, 12, 16)
- Component patterns (metric cards, status indicators, data tables)
- Dashboard-specific layout grids
- Real-time data update animations
- Accessibility requirements

## Database Schema

**Application Schema**: `shared/schema.ts` contains basic user authentication tables.

**Intelligence Schema**: `shared/intelligence-schema.ts` contains 30+ tables for agent observability (see "Database Schema for Intelligence" above for the full table listing).

Both schemas use Drizzle ORM with Zod validation (`createInsertSchema()` from `drizzle-zod`) and PostgreSQL via `@neondatabase/serverless`.

**Architectural invariant**: Omnidash never queries upstream databases directly. All intelligence data flows through Kafka into omnidash's own `omnidash_analytics` read-model database (see "Available Data Sources" above).
