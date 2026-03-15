# OmniDash

OmniDash is a real-time monitoring and observability dashboard for the OmniNode AI agent system. It visualizes Kafka event streams, agent routing decisions, pattern intelligence, cost trends, and execution graphs across the full OmniNode pipeline.

## Quick Start

```bash
npm install
cp .env.example .env   # fill in database and Kafka credentials
PORT=3000 npm run dev
```

The application runs at `http://localhost:3000`.

## Configuration

Key environment variables (see `.env.example` for the full template):

```bash
PORT=3000

# Omnidash read-model database (omnidash_analytics)
OMNIDASH_ANALYTICS_DB_URL="postgresql://postgres:<password>@localhost:5436/omnidash_analytics"

# Kafka event streaming (cloud bus; use localhost:19092 for local Docker bus)
KAFKA_BROKERS=localhost:29092
KAFKA_CLIENT_ID=omnidash-dashboard
KAFKA_CONSUMER_GROUP=omnidash-consumers-v2

ENABLE_REAL_TIME_EVENTS=true
```

Never hardcode passwords. Always source credentials from `.env`.

## Common Commands

**Development:**

```bash
PORT=3000 npm run dev     # Start development server
npm run check             # TypeScript type checking
npm run build             # Production build (Vite + esbuild)
PORT=3000 npm start       # Run production build
```

**Testing:**

```bash
npm run test              # Run vitest tests
npm run test:ui           # Interactive test UI
npm run test:coverage     # Generate coverage report
```

**Database:**

```bash
npm run db:push           # Push Drizzle schema changes
npm run db:migrate        # Run SQL migrations from migrations/
```

**Observability:**

```bash
npm run seed-events              # Seed test events once
npm run seed-events:continuous   # Continuous event seeding
npm run check-topics             # Check Kafka topic health
```

## Routes

### Category Dashboards

Top-level dashboards, always visible in the sidebar:

| Route | Page | Purpose |
|---|---|---|
| `/category/speed` | SpeedCategory | Cache hit rate, latency percentiles, pipeline health |
| `/category/success` | SuccessCategory | A/B comparison, injection hit rates, effectiveness trends |
| `/category/intelligence` | IntelligenceCategory | Pattern utilization, intent classification, behavior tracking |
| `/category/health` | SystemHealthCategory | Validation counts, node registry, health checks |

### Advanced Pages

Accessible via the collapsible Advanced section in the sidebar:

| Route | Page | Purpose |
|---|---|---|
| `/events` (default `/`) | EventBusMonitor | Real-time Kafka event stream visualization |
| `/live-events` | LiveEventStream | Raw live event stream view |
| `/extraction` | ExtractionDashboard | Pattern extraction pipeline metrics |
| `/effectiveness` | EffectivenessSummary | Injection effectiveness and A/B analysis |
| `/effectiveness/latency` | EffectivenessLatency | Latency breakdown by injection channel |
| `/effectiveness/utilization` | EffectivenessUtilization | Pattern utilization rates |
| `/effectiveness/ab` | EffectivenessAB | A/B experiment results |
| `/cost-trends` | CostTrendDashboard | LLM cost trends, budget alerts, token usage |
| `/intents` | IntentDashboard | Real-time intent classification and analysis |
| `/patterns` | PatternLearning | Code pattern discovery and learning analytics |
| `/enforcement` | PatternEnforcement | Enforcement hit rate, violations, correction rate |
| `/enrichment` | ContextEnrichmentDashboard | Hit rate per channel, token savings, latency |
| `/llm-routing` | LlmRoutingDashboard | LLM routing effectiveness metrics |
| `/registry` | NodeRegistry | Contract-driven node and service discovery |
| `/discovery` | RegistryDiscovery | ONEX node registry discovery |
| `/validation` | ValidationDashboard | Cross-repo validation runs and violation trends |
| `/graph` | ExecutionGraph | Live ONEX node execution graph |
| `/trace` | CorrelationTrace | Trace events by correlation ID |
| `/insights` | LearnedInsights | Patterns and conventions from OmniClaude sessions |
| `/baselines` | BaselinesROI | Cost and outcome baseline comparisons |
| `/showcase` | WidgetShowcase | Contract-driven widget type preview |
| `/chat` | Chat | AI assistant interactions |

## Project Structure

```
omnidash/
├── client/               # React frontend
│   └── src/
│       ├── components/   # Reusable UI components (shadcn/ui)
│       ├── pages/        # Active dashboard pages
│       ├── _archive/     # Legacy pages (OMN-1377)
│       ├── hooks/        # Custom React hooks (WebSocket, queries)
│       ├── contexts/     # React contexts (DemoMode, Theme)
│       └── lib/          # Utilities and data sources
├── server/               # Express backend
│   ├── index.ts          # Main server entry point
│   ├── routes.ts         # Route registration
│   ├── websocket.ts      # WebSocket server
│   ├── event-consumer.ts # Kafka consumer with event aggregation
│   ├── read-model-consumer.ts  # Projects Kafka events into local tables
│   ├── db-adapter.ts     # PostgreSQL connection and queries
│   ├── intelligence-routes.ts  # Agent observability API
│   ├── *-routes.ts       # Feature-specific API route modules
│   └── service-health.ts # Service health monitoring
└── shared/               # Shared types and schemas
    ├── schema.ts          # User authentication tables
    └── intelligence-schema.ts  # 30+ intelligence tracking tables
```

## Architecture

### Frontend

- **Framework**: React 18 with TypeScript
- **Router**: Wouter (lightweight SPA routing)
- **UI Components**: shadcn/ui (New York variant, Radix UI primitives)
- **State Management**: TanStack Query v5 for server state
- **Styling**: Tailwind CSS with Carbon Design System principles
- **Charts**: Recharts
- **Build**: Vite with HMR in development

### Backend

- **Framework**: Express.js
- **Database**: PostgreSQL with Drizzle ORM (`omnidash_analytics` read-model)
- **Real-time**: WebSocket server at `/ws` + KafkaJS consumer
- **Event pipeline**: Kafka topics projected into local tables by `read-model-consumer.ts`
- **Build**: esbuild (ESM, platform: node)

### Data Flow

Upstream OmniNode services publish events to Kafka. The `read-model-consumer` projects those events into the `omnidash_analytics` PostgreSQL database. API routes serve aggregated data from that read-model. The WebSocket server streams live events to connected clients with <100ms latency.

Omnidash never queries the upstream `omninode_bridge` database directly.

### Key Kafka Topics

- `agent-routing-decisions` - Agent selection with confidence scores
- `agent-transformation-events` - Polymorphic agent transformations
- `router-performance-metrics` - Routing performance data
- `agent-actions` - Tool calls, decisions, errors

## Code Quality

Pre-commit hooks run ESLint and Prettier automatically via Husky + lint-staged.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add LLM routing dashboard
fix: resolve WebSocket reconnection issue
docs: update route listing in README
```

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `revert`.

## License

MIT
