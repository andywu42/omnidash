#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Demo Pattern Data Seeder
 *
 * Seeds pattern_learning_artifacts table with realistic demo data for dashboard demos.
 * All demo records are marked with { __demo: true } in metadata for easy cleanup.
 *
 * WARNING (OMN-6394): When generating seed/demo data, always use dates within the
 * current year. Using historical dates (2024, 2025, etc.) pollutes dashboards with
 * unrealistic data and requires migration-based cleanup. Prefer Date.now() or dates
 * from the current month.
 *
 * Usage:
 *   npm run seed-demo-patterns     # Seed demo data
 *   npm run cleanup-demo-patterns  # Remove all demo data
 *
 * Or directly:
 *   npx tsx scripts/seed-demo-patterns.ts seed
 *   npx tsx scripts/seed-demo-patterns.ts cleanup
 */

import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

config();

// Build connection string from environment variables
function getConnectionString(): string {
  // Prefer DATABASE_URL if set
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // Otherwise, build from individual POSTGRES_* variables
  const { POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DATABASE, POSTGRES_USER, POSTGRES_PASSWORD } =
    process.env;

  if (
    !POSTGRES_HOST ||
    !POSTGRES_PORT ||
    !POSTGRES_DATABASE ||
    !POSTGRES_USER ||
    !POSTGRES_PASSWORD
  ) {
    console.error('ERROR: Database connection requires either DATABASE_URL or all of:');
    console.error(
      '  POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DATABASE, POSTGRES_USER, POSTGRES_PASSWORD'
    );
    console.error('Set these in .env file. See .env.example for reference.');
    process.exit(1);
  }

  const encodedUser = encodeURIComponent(POSTGRES_USER);
  const encodedPassword = encodeURIComponent(POSTGRES_PASSWORD);
  return `postgresql://${encodedUser}:${encodedPassword}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DATABASE}`;
}

const connectionString = getConnectionString();
const pool = new Pool({ connectionString });
const db = drizzle(pool);

// Demo data configuration
function createDemoMetadata(pattern: (typeof DEMO_PATTERNS)[number]) {
  return {
    __demo: true,
    __demoCreatedAt: new Date().toISOString(),
    description: pattern.description,
    codeExample: pattern.codeExample,
  };
}

// Realistic pattern definitions with descriptions and code examples
const DEMO_PATTERNS = [
  // Validated patterns (high scores, production-ready)
  {
    name: 'ONEX Effect Pattern',
    type: 'behavioral',
    lang: 'Python',
    score: 0.94,
    state: 'validated',
    description:
      'Declarative side-effect management for ONEX nodes. Isolates I/O operations from pure business logic, enabling deterministic testing and replay capabilities.',
    codeExample: `@effect
async def fetch_user(user_id: str) -> Effect[User]:
    return Effect.from_io(
        lambda: api.get_user(user_id)
    ).map(User.from_dict)`,
  },
  {
    name: 'Repository Gateway',
    type: 'architectural',
    lang: 'TypeScript',
    score: 0.91,
    state: 'validated',
    description:
      'Abstracts data persistence behind a clean interface, allowing seamless switching between PostgreSQL, Redis, or in-memory stores without changing business logic.',
    codeExample: `interface Repository<T> {
  find(id: string): Promise<T | null>;
  save(entity: T): Promise<void>;
  delete(id: string): Promise<boolean>;
}`,
  },
  {
    name: 'Event Sourcing Handler',
    type: 'architectural',
    lang: 'Python',
    score: 0.89,
    state: 'validated',
    description:
      'Persists all state changes as immutable events, enabling complete audit trails, time-travel debugging, and event replay for system recovery.',
    codeExample: `class EventStore:
    def append(self, stream: str, event: Event):
        self.events.append((stream, event))

    def replay(self, stream: str) -> State:
        return reduce(apply, self.get_events(stream))`,
  },
  {
    name: 'CQRS Command Bus',
    type: 'architectural',
    lang: 'TypeScript',
    score: 0.88,
    state: 'validated',
    description:
      'Separates read and write operations through dedicated command and query handlers, optimizing each path independently for performance and scalability.',
    codeExample: `class CommandBus {
  async execute<T>(command: Command<T>): Promise<T> {
    const handler = this.handlers.get(command.type);
    return handler.handle(command);
  }
}`,
  },
  {
    name: 'Circuit Breaker',
    type: 'behavioral',
    lang: 'Go',
    score: 0.92,
    state: 'validated',
    description:
      'Prevents cascade failures by monitoring error rates and temporarily blocking requests to failing services, with automatic recovery when health is restored.',
    codeExample: `func (cb *CircuitBreaker) Call(fn func() error) error {
    if cb.state == Open && time.Since(cb.lastFailure) < cb.timeout {
        return ErrCircuitOpen
    }
    return cb.execute(fn)
}`,
  },
  {
    name: 'Retry with Backoff',
    type: 'behavioral',
    lang: 'Python',
    score: 0.87,
    state: 'validated',
    description:
      'Automatically retries failed operations with exponential backoff and jitter, preventing thundering herd problems while maximizing success rates.',
    codeExample: `@retry(max_attempts=3, backoff=exponential(base=2))
async def call_external_api(url: str) -> Response:
    return await http.get(url)`,
  },

  // Provisional patterns (medium-high scores, under review)
  {
    name: 'Error Boundary Handler',
    type: 'behavioral',
    lang: 'TypeScript',
    score: 0.78,
    state: 'provisional',
    description:
      'Catches and gracefully handles errors at component boundaries, preventing entire application crashes and providing meaningful error feedback to users.',
    codeExample: `class ErrorBoundary extends Component {
  componentDidCatch(error: Error, info: ErrorInfo) {
    logError(error, info);
    this.setState({ hasError: true });
  }
}`,
  },
  {
    name: 'Async Queue Consumer',
    type: 'behavioral',
    lang: 'Python',
    score: 0.76,
    state: 'provisional',
    description:
      'Processes messages from Kafka/Redis queues with configurable concurrency, automatic acknowledgment, and dead-letter queue handling for failed messages.',
    codeExample: `async def consume(queue: Queue, handler: Handler):
    async for message in queue.subscribe():
        try:
            await handler.process(message)
            await queue.ack(message)
        except Exception:
            await queue.nack(message)`,
  },
  {
    name: 'Rate Limiter Middleware',
    type: 'behavioral',
    lang: 'Go',
    score: 0.74,
    state: 'provisional',
    description:
      'Enforces request rate limits using token bucket algorithm, protecting APIs from abuse while providing fair access across clients.',
    codeExample: `func RateLimiter(limit int, window time.Duration) Middleware {
    bucket := NewTokenBucket(limit, window)
    return func(next Handler) Handler {
        return func(r *Request) (*Response, error) {
            if !bucket.Allow() { return nil, ErrRateLimited }
            return next(r)
        }
    }
}`,
  },
  {
    name: 'Health Check Decorator',
    type: 'behavioral',
    lang: 'Python',
    score: 0.72,
    state: 'provisional',
    description:
      'Adds health monitoring capabilities to services, exposing liveness and readiness endpoints for Kubernetes orchestration and load balancer integration.',
    codeExample: `@health_check(path="/health")
class UserService:
    def is_healthy(self) -> bool:
        return self.db.ping() and self.cache.ping()`,
  },
  {
    name: 'Saga Orchestrator',
    type: 'architectural',
    lang: 'TypeScript',
    score: 0.79,
    state: 'provisional',
    description:
      'Coordinates distributed transactions across microservices using compensating actions, ensuring data consistency without distributed locks.',
    codeExample: `class OrderSaga extends Saga {
  *execute(order: Order) {
    yield this.step(reserveInventory, cancelReservation);
    yield this.step(processPayment, refundPayment);
    yield this.step(shipOrder, cancelShipment);
  }
}`,
  },
  {
    name: 'Domain Event Publisher',
    type: 'behavioral',
    lang: 'Python',
    score: 0.75,
    state: 'provisional',
    description:
      'Broadcasts domain events to interested subscribers, enabling loose coupling between aggregates and supporting eventual consistency patterns.',
    codeExample: `class EventPublisher:
    def publish(self, event: DomainEvent):
        for subscriber in self.subscribers[event.type]:
            asyncio.create_task(subscriber.handle(event))`,
  },

  // Candidate patterns (lower scores, new patterns)
  {
    name: 'Async Data Stream',
    type: 'behavioral',
    lang: 'Go',
    score: 0.65,
    state: 'candidate',
    description:
      'Enables reactive data processing with backpressure support, allowing efficient handling of high-volume data streams without memory overflow.',
    codeExample: `func Stream[T any](source <-chan T) *DataStream[T] {
    return &DataStream[T]{
        source: source,
        buffer: make(chan T, 100),
    }
}`,
  },
  {
    name: 'Lazy Loader Factory',
    type: 'creational',
    lang: 'TypeScript',
    score: 0.58,
    state: 'candidate',
    description:
      'Defers expensive object creation until first access, reducing startup time and memory usage for infrequently used dependencies.',
    codeExample: `const lazyService = lazy(() => new ExpensiveService());
// Service only created on first call
const result = lazyService.get().process(data);`,
  },
  {
    name: 'Observer Chain',
    type: 'behavioral',
    lang: 'Rust',
    score: 0.62,
    state: 'candidate',
    description:
      'Links multiple observers in a chain where each can modify or filter events before passing to the next, enabling composable event processing.',
    codeExample: `impl Observer for LoggingObserver {
    fn notify(&self, event: &Event) -> Option<Event> {
        log::info!("{:?}", event);
        self.next.as_ref().and_then(|n| n.notify(event))
    }
}`,
  },
  {
    name: 'Polymorphic Reducer',
    type: 'structural',
    lang: 'Python',
    score: 0.55,
    state: 'candidate',
    description:
      'Handles multiple action types through a single reducer interface, using pattern matching to delegate to specialized sub-reducers.',
    codeExample: `def reducer(state: State, action: Action) -> State:
    match action:
        case AddItem(item): return state.add(item)
        case RemoveItem(id): return state.remove(id)
        case _: return state`,
  },
  {
    name: 'State Machine Builder',
    type: 'creational',
    lang: 'TypeScript',
    score: 0.61,
    state: 'candidate',
    description:
      'Fluent API for defining state machines with type-safe transitions, guards, and actions, making complex workflows easy to model and maintain.',
    codeExample: `const machine = StateMachine.create()
  .state('idle').on('START').transitionTo('running')
  .state('running').on('STOP').transitionTo('idle')
  .build();`,
  },
  {
    name: 'Proxy Cache Handler',
    type: 'structural',
    lang: 'Go',
    score: 0.59,
    state: 'candidate',
    description:
      'Transparently caches method results using a proxy layer, with configurable TTL and invalidation strategies per method.',
    codeExample: `func WithCache(target Service, cache Cache) Service {
    return &CachingProxy{
        target: target,
        cache:  cache,
        ttl:    5 * time.Minute,
    }
}`,
  },
  {
    name: 'Dependency Container',
    type: 'creational',
    lang: 'Python',
    score: 0.63,
    state: 'candidate',
    description:
      'Manages object lifecycles and dependencies through inversion of control, supporting singleton, transient, and scoped lifetimes.',
    codeExample: `container = Container()
container.register(Database, singleton=True)
container.register(UserRepo, depends=[Database])

repo = container.resolve(UserRepo)`,
  },
  {
    name: 'Plugin Loader',
    type: 'creational',
    lang: 'Rust',
    score: 0.57,
    state: 'candidate',
    description:
      'Dynamically loads and initializes plugins at runtime from shared libraries, with version checking and graceful error handling.',
    codeExample: `pub fn load_plugin(path: &Path) -> Result<Box<dyn Plugin>> {
    let lib = Library::new(path)?;
    let create: Symbol<fn() -> Box<dyn Plugin>> =
        unsafe { lib.get(b"create_plugin")? };
    Ok(create())
}`,
  },

  // Deprecated patterns (historical, phased out)
  {
    name: 'Service Registry Pattern',
    type: 'creational',
    lang: 'Python',
    score: 0.45,
    state: 'deprecated',
    description:
      'DEPRECATED: Global service locator replaced by dependency injection. Caused hidden dependencies and made testing difficult.',
    codeExample: `# DEPRECATED - Use dependency injection instead
registry = ServiceRegistry.instance()
user_service = registry.get("UserService")`,
  },
  {
    name: 'Monolithic Controller',
    type: 'architectural',
    lang: 'TypeScript',
    score: 0.38,
    state: 'deprecated',
    description:
      'DEPRECATED: Single controller handling all routes. Replaced by domain-driven route handlers for better separation of concerns.',
    codeExample: `// DEPRECATED - Split into domain controllers
class AppController {
  users() { /* ... */ }
  orders() { /* ... */ }
  payments() { /* ... */ }
}`,
  },
  {
    name: 'Singleton Database Pool',
    type: 'creational',
    lang: 'Go',
    score: 0.42,
    state: 'deprecated',
    description:
      'DEPRECATED: Global database connection pool. Replaced by context-scoped pools for better resource management and testing.',
    codeExample: `// DEPRECATED - Use context-scoped pools
var globalPool *sql.DB
func GetDB() *sql.DB {
    if globalPool == nil { globalPool = connect() }
    return globalPool
}`,
  },
  {
    name: 'Global State Manager',
    type: 'structural',
    lang: 'TypeScript',
    score: 0.35,
    state: 'deprecated',
    description:
      'DEPRECATED: Mutable global state container. Replaced by immutable state with explicit update functions for predictability.',
    codeExample: `// DEPRECATED - Use immutable state patterns
const globalState = { user: null, cart: [] };
export function updateState(key, value) {
  globalState[key] = value; // Mutation!
}`,
  },
  {
    name: 'Callback Hell Handler',
    type: 'behavioral',
    lang: 'Python',
    score: 0.32,
    state: 'deprecated',
    description:
      'DEPRECATED: Nested callback chains for async operations. Replaced by async/await for readable, maintainable async code.',
    codeExample: `# DEPRECATED - Use async/await
def fetch_data(callback):
    get_user(lambda user:
        get_orders(user.id, lambda orders:
            callback(user, orders)))`,
  },
];

// Helper to generate realistic scoring evidence matching Zod schema
function generateScoringEvidence(score: number, state: string) {
  // Generate scores that roughly correlate with composite score
  const labelScore = Math.min(1.0, score + (Math.random() * 0.15 - 0.075));
  const clusterScore = Math.min(1.0, score + (Math.random() * 0.1 - 0.05));
  const frequencyScore = Math.min(1.0, score + (Math.random() * 0.2 - 0.1));

  const memberCount =
    state === 'validated'
      ? Math.floor(Math.random() * 50 + 20)
      : state === 'provisional'
        ? Math.floor(Math.random() * 15 + 5)
        : state === 'candidate'
          ? Math.floor(Math.random() * 5 + 1)
          : Math.floor(Math.random() * 3 + 1);

  const observedCount =
    state === 'validated'
      ? Math.floor(Math.random() * 100 + 50)
      : state === 'provisional'
        ? Math.floor(Math.random() * 30 + 15)
        : state === 'candidate'
          ? Math.floor(Math.random() * 10 + 3)
          : Math.floor(Math.random() * 5 + 1);

  // Must match Zod schema: labelAgreement, clusterCohesion, frequencyFactor
  return {
    labelAgreement: {
      score: Math.round(labelScore * 1000) / 1000,
      matchedLabels: ['effect', 'async', 'handler', 'pattern'].slice(
        0,
        Math.floor(Math.random() * 3) + 1
      ),
      totalLabels: Math.floor(Math.random() * 5) + 3,
      disagreements:
        score < 0.7 ? ['validation', 'scope'].slice(0, Math.floor(Math.random() * 2)) : undefined,
    },
    clusterCohesion: {
      score: Math.round(clusterScore * 1000) / 1000,
      clusterId: `cluster-${randomUUID().substring(0, 8)}`,
      memberCount,
      avgPairwiseSimilarity: Math.round((0.6 + Math.random() * 0.35) * 1000) / 1000,
      medoidId: `medoid-${randomUUID().substring(0, 8)}`,
    },
    frequencyFactor: {
      score: Math.round(frequencyScore * 1000) / 1000,
      observedCount,
      minRequired: 10,
      windowDays: 30,
    },
  };
}

// Helper to generate realistic signature matching Zod schema
function generateSignature(name: string, type: string, lang: string) {
  // Extract meaningful inputs from pattern name and type
  const inputs = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .split('_')
    .filter(Boolean)
    .slice(0, 4);

  // Add language-specific inputs
  if (lang === 'Python') {
    inputs.push('decorators', 'type_hints');
  } else if (lang === 'TypeScript') {
    inputs.push('generics', 'interfaces');
  } else if (lang === 'Go') {
    inputs.push('interfaces', 'goroutines');
  } else if (lang === 'Rust') {
    inputs.push('traits', 'lifetimes');
  }

  // Must match Zod schema: hash, version, algorithm, inputs, normalizations?
  return {
    hash: randomUUID().replace(/-/g, '').substring(0, 32),
    version: `1.${Math.floor(Math.random() * 5)}.${Math.floor(Math.random() * 10)}`,
    algorithm: 'sha256',
    inputs: [...new Set(inputs)], // Deduplicate
    normalizations: ['lowercase', 'whitespace_trim', 'comment_strip'].slice(
      0,
      Math.floor(Math.random() * 3) + 1
    ),
  };
}

// Helper to generate realistic metrics matching Zod schema
function generateMetrics(score: number, state: string) {
  const inputCount =
    state === 'validated'
      ? Math.floor(Math.random() * 500 + 200)
      : state === 'provisional'
        ? Math.floor(Math.random() * 150 + 50)
        : state === 'candidate'
          ? Math.floor(Math.random() * 50 + 10)
          : Math.floor(Math.random() * 20 + 5);

  const clusterCount = Math.floor(Math.random() * 15 + 3);
  const dedupMergeCount = Math.floor(Math.random() * inputCount * 0.1);

  // Generate score history for validated/provisional patterns
  const scoreHistory =
    state === 'validated' || state === 'provisional'
      ? Array.from({ length: Math.floor(Math.random() * 5) + 2 }, (_, i) => ({
          score: Math.round((score - 0.1 + Math.random() * 0.2) * 1000) / 1000,
          timestamp: new Date(Date.now() - (i + 1) * 7 * 24 * 60 * 60 * 1000).toISOString(),
        }))
      : undefined;

  // Must match Zod schema: processingTimeMs, inputCount, clusterCount, dedupMergeCount, scoreHistory?
  return {
    processingTimeMs: Math.floor(Math.random() * 500 + 50),
    inputCount,
    clusterCount,
    dedupMergeCount,
    ...(scoreHistory ? { scoreHistory } : {}),
  };
}

async function seedDemoPatterns(): Promise<void> {
  console.log('\n=== Seeding Demo Pattern Data ===\n');
  console.log(`Creating ${DEMO_PATTERNS.length} demo patterns with __demo marker...\n`);

  let inserted = 0;
  const errors: string[] = [];

  for (const pattern of DEMO_PATTERNS) {
    const patternId = randomUUID();
    const stateChangedAt = new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000);
    const createdAt = new Date(stateChangedAt.getTime() - Math.random() * 60 * 24 * 60 * 60 * 1000);

    const scoringEvidence = generateScoringEvidence(pattern.score, pattern.state);
    const signature = generateSignature(pattern.name, pattern.type, pattern.lang);
    const metrics = generateMetrics(pattern.score, pattern.state);

    try {
      await db.execute(sql`
        INSERT INTO pattern_learning_artifacts (
          id,
          pattern_id,
          pattern_name,
          pattern_type,
          language,
          lifecycle_state,
          state_changed_at,
          composite_score,
          scoring_evidence,
          signature,
          metrics,
          metadata,
          created_at,
          updated_at
        ) VALUES (
          ${randomUUID()},
          ${patternId},
          ${pattern.name},
          ${pattern.type},
          ${pattern.lang},
          ${pattern.state},
          ${stateChangedAt.toISOString()},
          ${pattern.score.toString()},
          ${JSON.stringify(scoringEvidence)},
          ${JSON.stringify(signature)},
          ${JSON.stringify(metrics)},
          ${JSON.stringify(createDemoMetadata(pattern))},
          ${createdAt.toISOString()},
          ${new Date().toISOString()}
        )
      `);

      inserted++;
      const stateIcon =
        pattern.state === 'validated'
          ? '[OK]'
          : pattern.state === 'provisional'
            ? '[~~]'
            : pattern.state === 'candidate'
              ? '[??]'
              : '[XX]';
      console.log(`  ${stateIcon} ${pattern.name} (${pattern.lang}, score: ${pattern.score})`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`${pattern.name}: ${errorMsg}`);
      console.error(`  [!!] Failed: ${pattern.name} - ${errorMsg}`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  Inserted: ${inserted}/${DEMO_PATTERNS.length}`);
  if (errors.length > 0) {
    console.log(`  Errors: ${errors.length}`);
  }
  console.log('\n  All demo records have metadata: { "__demo": true }');
  console.log('  Run "npm run cleanup-demo-patterns" to remove them.\n');
}

async function cleanupDemoPatterns(): Promise<void> {
  console.log('\n=== Cleaning Up Demo Pattern Data ===\n');

  try {
    // Count demo records first
    const countResult = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM pattern_learning_artifacts
      WHERE metadata->>'__demo' = 'true'
    `);

    const count = (countResult.rows[0] as { count: string })?.count || '0';
    console.log(`  Found ${count} demo records to delete...\n`);

    if (parseInt(count, 10) === 0) {
      console.log('  No demo records found. Nothing to clean up.\n');
      return;
    }

    // Delete demo records
    const deleteResult = await db.execute(sql`
      DELETE FROM pattern_learning_artifacts
      WHERE metadata->>'__demo' = 'true'
      RETURNING id, pattern_name
    `);

    const deleted = deleteResult.rows?.length || 0;
    console.log(`  Deleted ${deleted} demo records.\n`);

    // Verify cleanup
    const verifyResult = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM pattern_learning_artifacts
      WHERE metadata->>'__demo' = 'true'
    `);

    const remaining = (verifyResult.rows[0] as { count: string })?.count || '0';
    if (parseInt(remaining, 10) === 0) {
      console.log('  Cleanup verified - no demo records remain.\n');
    } else {
      console.error(`  WARNING: ${remaining} demo records still remain!\n`);
    }
  } catch (error) {
    console.error('  Error during cleanup:', error);
    throw error;
  }
}

async function showStatus(): Promise<void> {
  console.log('\n=== Demo Pattern Status ===\n');

  try {
    // Count demo records
    const demoCount = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM pattern_learning_artifacts
      WHERE metadata->>'__demo' = 'true'
    `);

    // Count total records
    const totalCount = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM pattern_learning_artifacts
    `);

    // Breakdown by state
    const stateBreakdown = await db.execute(sql`
      SELECT lifecycle_state, COUNT(*) as count
      FROM pattern_learning_artifacts
      WHERE metadata->>'__demo' = 'true'
      GROUP BY lifecycle_state
      ORDER BY count DESC
    `);

    const demo = (demoCount.rows[0] as { count: string })?.count || '0';
    const total = (totalCount.rows[0] as { count: string })?.count || '0';

    console.log(`  Demo records: ${demo}`);
    console.log(`  Total records: ${total}`);
    console.log(`  Production records: ${parseInt(total, 10) - parseInt(demo, 10)}`);

    if (stateBreakdown.rows.length > 0) {
      console.log('\n  Demo breakdown by lifecycle state:');
      for (const row of stateBreakdown.rows as Array<{ lifecycle_state: string; count: string }>) {
        console.log(`    ${row.lifecycle_state}: ${row.count}`);
      }
    }

    console.log('');
  } catch (error) {
    console.error('  Error checking status:', error);
    throw error;
  }
}

// Main entry point
const command = process.argv[2] || 'seed';

async function main() {
  try {
    switch (command) {
      case 'seed':
        await seedDemoPatterns();
        break;
      case 'cleanup':
      case 'clean':
        await cleanupDemoPatterns();
        break;
      case 'status':
        await showStatus();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Usage: npx tsx scripts/seed-demo-patterns.ts [seed|cleanup|status]');
        process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
