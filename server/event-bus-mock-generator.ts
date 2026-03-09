/**
 * Event Bus Mock Generator
 *
 * Simulates Kafka events by generating realistic event chains following the event catalog.
 * Can be used in development mode to populate EventBusDataSource without requiring Kafka.
 *
 * Features:
 * - Generates events matching event catalog patterns
 * - Creates realistic event chains (requested → started → completed/failed)
 * - Supports all event domains (intelligence, agent, metadata, code, etc.)
 * - Can inject events directly into EventBusDataSource
 */

import { randomUUID } from 'crypto';
import { eventBusDataSource, type EventBusEvent } from './event-bus-data-source';

/**
 * Mock Event Generator for Event Bus
 */
export class EventBusMockGenerator {
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;
  private tenantId: string;
  private namespace: string;
  private offsetCounter = 0; // Sequential offset counter to match Kafka semantics

  constructor(options: { tenantId?: string; namespace?: string } = {}) {
    this.tenantId = options.tenantId ?? 'default-tenant';
    this.namespace = options.namespace ?? 'development';
  }

  // Agent configurations
  private agents = [
    'agent-api-architect',
    'agent-performance',
    'agent-debug-intelligence',
    'agent-python-fastapi-expert',
    'agent-testing',
    'agent-frontend-developer',
    'agent-database-specialist',
    'agent-security-expert',
  ];

  // Sample queries/requests
  private queries = [
    'optimize database query performance',
    'fix authentication bug',
    'add new API endpoint',
    'refactor legacy code',
    'implement caching layer',
    'debug memory leak',
    'setup CI/CD pipeline',
    'create unit tests',
  ];

  /**
   * Start generating events
   */
  async start(
    options: {
      continuous?: boolean;
      interval_ms?: number;
      initialChains?: number;
    } = {}
  ): Promise<void> {
    // Prevent multiple overlapping start() calls
    // Set isRunning immediately after check to prevent race conditions
    if (this.isRunning) {
      console.log('[EventBusMockGenerator] Already running; ignoring start()');
      return;
    }
    this.isRunning = true; // Set immediately to prevent race condition

    const {
      continuous = true,
      interval_ms = 5000, // Generate events every 5 seconds
      initialChains = 20,
    } = options;

    // Generate initial event chains with error handling
    console.log(`[EventBusMockGenerator] Generating ${initialChains} initial event chains...`);
    try {
      for (let i = 0; i < initialChains; i++) {
        await this.generateRandomEventChain();
      }
    } catch (error) {
      console.error('[EventBusMockGenerator] Error generating initial chains:', error);
      this.isRunning = false;
      throw error;
    }

    if (continuous) {
      console.log(
        `[EventBusMockGenerator] Starting continuous event generation (every ${interval_ms}ms)...`
      );
      this.intervalId = setInterval(() => {
        this.generateRandomEventChain().catch((err) => {
          console.error('[EventBusMockGenerator] Error generating event chain:', err);
        });
      }, interval_ms);
    }
  }

  /**
   * Stop generating events
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
    console.log('[EventBusMockGenerator] Stopped');
  }

  /**
   * Generate a random event chain
   */
  private async generateRandomEventChain(): Promise<void> {
    const chainType = Math.random();

    if (chainType < 0.3) {
      // Intelligence query chain (30%)
      await this.generateIntelligenceQueryChain();
    } else if (chainType < 0.5) {
      // Agent execution chain (20%)
      await this.generateAgentExecutionChain();
    } else if (chainType < 0.65) {
      // Code generation chain (15%)
      await this.generateCodeGenerationChain();
    } else if (chainType < 0.75) {
      // Metadata stamping chain (10%)
      await this.generateMetadataStampingChain();
    } else if (chainType < 0.85) {
      // Database query chain (10%)
      await this.generateDatabaseQueryChain();
    } else {
      // Vault secret chain (15%)
      await this.generateVaultSecretChain();
    }
  }

  /**
   * Generate intelligence query event chain
   */
  private async generateIntelligenceQueryChain(): Promise<void> {
    const correlationId = randomUUID();
    const query = this.queries[Math.floor(Math.random() * this.queries.length)];
    const source = 'omniintelligence';

    // Requested event
    const requestedEventId = randomUUID();
    await this.emitEvent({
      event_type: 'omninode.intelligence.query.requested.v1',
      event_id: requestedEventId,
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      schema_ref: 'registry://omninode/intelligence/query_requested/v1',
      payload: {
        query,
        operation_type: 'code_analysis',
        context: { user_id: 'user-123', session_id: randomUUID() },
      },
      topic: `${this.tenantId}.omninode.intelligence.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });

    // Wait a bit, then completed event
    await this.sleep(100 + Math.random() * 200);

    await this.emitEvent({
      event_type: 'omninode.intelligence.query.completed.v1',
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      causation_id: requestedEventId, // Reference the previous event
      schema_ref: 'registry://omninode/intelligence/query_completed/v1',
      payload: {
        query,
        result: {
          analysis: 'Code analysis completed',
          quality_score: 0.85 + Math.random() * 0.1,
          recommendations: ['Optimize query', 'Add caching'],
        },
        duration_ms: Math.floor(100 + Math.random() * 300),
      },
      topic: `${this.tenantId}.omninode.intelligence.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });
  }

  /**
   * Generate agent execution event chain
   */
  private async generateAgentExecutionChain(): Promise<void> {
    const correlationId = randomUUID();
    const agent = this.agents[Math.floor(Math.random() * this.agents.length)];
    const query = this.queries[Math.floor(Math.random() * this.queries.length)];
    const source = 'omniclaude';

    // Routing requested
    const routingRequestedId = randomUUID();
    await this.emitEvent({
      event_type: 'omninode.agent.routing.requested.v1',
      event_id: routingRequestedId,
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      schema_ref: 'registry://omninode/agent/routing_requested/v1',
      payload: {
        query,
        context: { user_id: 'user-123' },
      },
      topic: `${this.tenantId}.omninode.agent.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });

    await this.sleep(50 + Math.random() * 100);

    // Routing completed
    const routingCompletedId = randomUUID();
    await this.emitEvent({
      event_type: 'omninode.agent.routing.completed.v1',
      event_id: routingCompletedId,
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      causation_id: routingRequestedId, // Reference the previous event
      schema_ref: 'registry://omninode/agent/routing_completed/v1',
      payload: {
        selected_agent: agent,
        confidence_score: 0.8 + Math.random() * 0.15,
        routing_strategy: 'semantic_similarity',
        routing_time_ms: Math.floor(50 + Math.random() * 100),
      },
      topic: `${this.tenantId}.omninode.agent.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });

    await this.sleep(100);

    // Execution started
    const executionStartedId = randomUUID();
    await this.emitEvent({
      event_type: 'omninode.agent.execution.started.v1',
      event_id: executionStartedId,
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      causation_id: routingCompletedId, // Reference the previous event
      schema_ref: 'registry://omninode/agent/execution_started/v1',
      payload: {
        agent_id: agent,
        query,
      },
      topic: `${this.tenantId}.omninode.agent.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });

    await this.sleep(500 + Math.random() * 1000);

    // Execution completed (90% success rate)
    if (Math.random() < 0.9) {
      await this.emitEvent({
        event_type: 'omninode.agent.execution.completed.v1',
        event_id: randomUUID(),
        timestamp: new Date().toISOString(),
        tenant_id: this.tenantId,
        namespace: this.namespace,
        source,
        correlation_id: correlationId,
        causation_id: executionStartedId, // Reference the previous event
        schema_ref: 'registry://omninode/agent/execution_completed/v1',
        payload: {
          agent_id: agent,
          query,
          result: 'Task completed successfully',
          duration_ms: Math.floor(500 + Math.random() * 1000),
          tokens_used: Math.floor(1000 + Math.random() * 2000),
          cost: 0.01 + Math.random() * 0.05,
        },
        topic: `${this.tenantId}.omninode.agent.v1`,
        partition: 0,
        offset: this.getNextOffset(),
        processed_at: new Date(),
      });
    } else {
      await this.emitEvent({
        event_type: 'omninode.agent.execution.failed.v1',
        event_id: randomUUID(),
        timestamp: new Date().toISOString(),
        tenant_id: this.tenantId,
        namespace: this.namespace,
        source,
        correlation_id: correlationId,
        causation_id: executionStartedId, // Reference the previous event
        schema_ref: 'registry://omninode/agent/execution_failed/v1',
        payload: {
          agent_id: agent,
          query,
          error: 'Execution failed',
          duration_ms: Math.floor(200 + Math.random() * 300),
        },
        topic: `${this.tenantId}.omninode.agent.v1`,
        partition: 0,
        offset: this.getNextOffset(),
        processed_at: new Date(),
      });
    }
  }

  /**
   * Generate code generation event chain
   */
  private async generateCodeGenerationChain(): Promise<void> {
    const correlationId = randomUUID();
    const contractId = randomUUID();
    const source = 'omnibase_infra';

    const requestedEventId = randomUUID();
    await this.emitEvent({
      event_type: 'omninode.code.generation.requested.v1',
      event_id: requestedEventId,
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      schema_ref: 'registry://omninode/code/generation_requested/v1',
      payload: {
        contract_id: contractId,
        specification: 'Generate API endpoint',
      },
      topic: `${this.tenantId}.omninode.code.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });

    await this.sleep(200 + Math.random() * 300);

    await this.emitEvent({
      event_type: 'omninode.code.generation.completed.v1',
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      causation_id: requestedEventId, // Reference the previous event
      schema_ref: 'registry://omninode/code/generation_completed/v1',
      payload: {
        contract_id: contractId,
        files_generated: Math.floor(1 + Math.random() * 5),
        duration_ms: Math.floor(200 + Math.random() * 300),
      },
      topic: `${this.tenantId}.omninode.code.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });
  }

  /**
   * Generate metadata stamping event chain
   */
  private async generateMetadataStampingChain(): Promise<void> {
    const correlationId = randomUUID();
    const artifactHash = randomUUID();
    const source = 'omnibase_infra';

    const requestedEventId = randomUUID();
    await this.emitEvent({
      event_type: 'omninode.metadata.stamping.requested.v1',
      event_id: requestedEventId,
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      schema_ref: 'registry://omninode/metadata/stamping_requested/v1',
      payload: {
        target_artifact_hash: artifactHash,
        artifact_path: '/path/to/file.ts',
      },
      topic: `${this.tenantId}.omninode.metadata.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });

    await this.sleep(50 + Math.random() * 100);

    await this.emitEvent({
      event_type: 'omninode.metadata.stamping.stamped.v1',
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      causation_id: requestedEventId, // Reference the previous event
      schema_ref: 'registry://omninode/metadata/stamping_stamped/v1',
      payload: {
        target_artifact_hash: artifactHash,
        metadata: {
          version: '1.0.0',
          author: 'system',
        },
      },
      topic: `${this.tenantId}.omninode.metadata.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });
  }

  /**
   * Generate database query event chain
   */
  private async generateDatabaseQueryChain(): Promise<void> {
    const correlationId = randomUUID();
    const source = 'postgres-adapter';

    const requestedEventId = randomUUID();
    await this.emitEvent({
      event_type: 'omninode.database.query.requested.v1',
      event_id: requestedEventId,
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      schema_ref: 'registry://omninode/database/query_requested/v1',
      payload: {
        query: 'SELECT * FROM users LIMIT 10',
        query_type: 'select',
      },
      topic: `${this.tenantId}.omninode.database.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });

    await this.sleep(10 + Math.random() * 50);

    await this.emitEvent({
      event_type: 'omninode.database.query.completed.v1',
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      causation_id: requestedEventId, // Reference the previous event
      schema_ref: 'registry://omninode/database/query_completed/v1',
      payload: {
        rows_returned: Math.floor(5 + Math.random() * 10),
        duration_ms: Math.floor(10 + Math.random() * 50),
      },
      topic: `${this.tenantId}.omninode.database.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });
  }

  /**
   * Generate Vault secret event chain
   */
  private async generateVaultSecretChain(): Promise<void> {
    const correlationId = randomUUID();
    const secretPath = `secret/data/app/${Math.floor(Math.random() * 10)}`;
    const source = 'vault-adapter';

    const requestedEventId = randomUUID();
    await this.emitEvent({
      event_type: 'omninode.vault.secret.read.requested.v1',
      event_id: requestedEventId,
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      schema_ref: 'registry://omninode/vault/secret_read_requested/v1',
      payload: {
        secret_path: secretPath,
        // Note: Secret values are NEVER included in events
      },
      topic: `${this.tenantId}.omninode.vault.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });

    await this.sleep(20 + Math.random() * 30);

    await this.emitEvent({
      event_type: 'omninode.vault.secret.read.completed.v1',
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      tenant_id: this.tenantId,
      namespace: this.namespace,
      source,
      correlation_id: correlationId,
      causation_id: requestedEventId, // Reference the previous event
      schema_ref: 'registry://omninode/vault/secret_read_completed/v1',
      payload: {
        secret_path: secretPath,
        // Only metadata, no secret values
        metadata: {
          version: 1,
          created_time: new Date().toISOString(),
        },
      },
      topic: `${this.tenantId}.omninode.vault.v1`,
      partition: 0,
      offset: this.getNextOffset(),
      processed_at: new Date(),
    });
  }

  /**
   * Get next sequential offset (Kafka offsets are numeric strings)
   */
  private getNextOffset(): string {
    return String(this.offsetCounter++);
  }

  /**
   * Emit event directly to EventBusDataSource
   */
  private async emitEvent(event: EventBusEvent): Promise<void> {
    // Inject event directly into EventBusDataSource
    await eventBusDataSource.injectEvent(event);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const eventBusMockGenerator = new EventBusMockGenerator();
