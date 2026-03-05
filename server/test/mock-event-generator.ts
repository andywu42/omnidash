import { Kafka, Producer } from 'kafkajs';
import { TOPIC_OMNICLAUDE_ROUTING_DECISIONS, TOPIC_OMNICLAUDE_AGENT_ACTIONS } from '@shared/topics';

/**
 * Mock Event Generator for Kafka Topics
 *
 * Generates realistic events to populate the Omnidash dashboard:
 * - Agent routing decisions
 * - Agent actions (tool calls, decisions, errors, successes)
 * - Transformation events (future)
 * - Performance metrics (future)
 *
 * Usage:
 *   npm run seed-events              # Run once to seed initial data
 *   npm run seed-events -- --continuous  # Run continuously for testing
 */

interface MockAgentConfig {
  name: string;
  specialization: string;
  avgConfidence: number; // 0.0-1.0
  avgRoutingTime: number; // milliseconds
  actionTypes: string[];
}

class MockEventGenerator {
  private kafka: Kafka;
  private producer: Producer | null = null;
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;

  // Realistic agent configurations based on the 52-agent system
  private agents: MockAgentConfig[] = [
    {
      name: 'agent-api-architect',
      specialization: 'API Design',
      avgConfidence: 0.92,
      avgRoutingTime: 85,
      actionTypes: ['Read', 'Write', 'Edit', 'Task'],
    },
    {
      name: 'agent-performance',
      specialization: 'Performance Optimization',
      avgConfidence: 0.89,
      avgRoutingTime: 95,
      actionTypes: ['Read', 'Grep', 'Bash', 'Edit'],
    },
    {
      name: 'agent-debug-intelligence',
      specialization: 'Debugging',
      avgConfidence: 0.87,
      avgRoutingTime: 110,
      actionTypes: ['Read', 'Grep', 'Bash', 'Task'],
    },
    {
      name: 'agent-python-fastapi-expert',
      specialization: 'Python/FastAPI',
      avgConfidence: 0.94,
      avgRoutingTime: 75,
      actionTypes: ['Read', 'Write', 'Edit', 'Bash'],
    },
    {
      name: 'agent-testing',
      specialization: 'Testing',
      avgConfidence: 0.88,
      avgRoutingTime: 90,
      actionTypes: ['Read', 'Write', 'Bash', 'Task'],
    },
    {
      name: 'agent-ui-testing',
      specialization: 'UI Testing',
      avgConfidence: 0.85,
      avgRoutingTime: 105,
      actionTypes: ['Read', 'Write', 'Task'],
    },
    {
      name: 'agent-repository-setup',
      specialization: 'Repository Setup',
      avgConfidence: 0.91,
      avgRoutingTime: 80,
      actionTypes: ['Bash', 'Write', 'Edit'],
    },
    {
      name: 'agent-structured-logging',
      specialization: 'Logging',
      avgConfidence: 0.86,
      avgRoutingTime: 95,
      actionTypes: ['Read', 'Edit', 'Grep'],
    },
    {
      name: 'agent-ast-generator',
      specialization: 'AST Generation',
      avgConfidence: 0.93,
      avgRoutingTime: 70,
      actionTypes: ['Read', 'Write', 'Task'],
    },
    {
      name: 'agent-multi-step-framework',
      specialization: 'Multi-Step Workflows',
      avgConfidence: 0.9,
      avgRoutingTime: 100,
      actionTypes: ['Task', 'Read', 'Write'],
    },
    {
      name: 'polymorphic-agent',
      specialization: 'Orchestration',
      avgConfidence: 0.95,
      avgRoutingTime: 65,
      actionTypes: ['Task', 'Read', 'AskUserQuestion'],
    },
    {
      name: 'agent-database-specialist',
      specialization: 'Database',
      avgConfidence: 0.89,
      avgRoutingTime: 90,
      actionTypes: ['Read', 'Edit', 'Bash', 'Task'],
    },
    {
      name: 'agent-security-expert',
      specialization: 'Security',
      avgConfidence: 0.92,
      avgRoutingTime: 85,
      actionTypes: ['Read', 'Grep', 'Edit', 'Task'],
    },
    {
      name: 'agent-devops-automation',
      specialization: 'DevOps',
      avgConfidence: 0.87,
      avgRoutingTime: 110,
      actionTypes: ['Bash', 'Read', 'Write'],
    },
    {
      name: 'agent-frontend-specialist',
      specialization: 'Frontend',
      avgConfidence: 0.88,
      avgRoutingTime: 95,
      actionTypes: ['Read', 'Write', 'Edit', 'Task'],
    },
  ];

  private userRequests = [
    'optimize database query performance',
    'fix authentication bug in user login',
    'add new API endpoint for user data',
    'refactor legacy code for better maintainability',
    'implement caching layer for API responses',
    'debug memory leak in production',
    'setup CI/CD pipeline for automated deployment',
    'create unit tests for new feature',
    'improve error handling in payment flow',
    'analyze performance bottlenecks in dashboard',
    'migrate database schema to new version',
    'implement rate limiting for API',
    'fix CORS issues in development environment',
    'add monitoring and alerting for critical services',
    'optimize frontend bundle size',
  ];

  private routingStrategies = [
    'trigger_match',
    'semantic_similarity',
    'capability_overlap',
    'fallback',
    'enhanced_fuzzy_matching',
    'explicit_request',
  ];

  constructor() {
    const brokers = process.env.KAFKA_BROKERS || process.env.KAFKA_BOOTSTRAP_SERVERS;
    if (!brokers) {
      throw new Error(
        'KAFKA_BROKERS or KAFKA_BOOTSTRAP_SERVERS environment variable is required. ' +
          'Set it in .env file or export it before running mock generator. ' +
          'Example: KAFKA_BROKERS=host:port'
      );
    }
    this.kafka = new Kafka({
      brokers: brokers.split(','),
      clientId: 'omnidash-mock-generator',
    });
    this.producer = this.kafka.producer();
  }

  async start(options: { continuous?: boolean; initialBatch?: number } = {}) {
    const { continuous = false, initialBatch = 100 } = options;

    try {
      await this.producer!.connect();
      console.log('Mock event generator connected to Kafka');
      console.log(`Brokers: ${process.env.KAFKA_BROKERS || process.env.KAFKA_BOOTSTRAP_SERVERS}`);
      this.isRunning = true;

      // Publish initial batch of events
      console.log(`\nPublishing initial batch of ${initialBatch} events...`);
      await this.publishInitialData(initialBatch);

      if (continuous) {
        console.log('\nStarting continuous event generation (every 3 seconds)...');
        console.log('Press Ctrl+C to stop\n');

        // Start continuous event generation (every 3 seconds)
        this.intervalId = setInterval(() => {
          this.publishRandomEvents().catch((err) => {
            console.error('Error publishing random events:', err);
          });
        }, 3000);
      } else {
        console.log('\n✅ Initial data seeding complete!');
        await this.stop();
      }
    } catch (error) {
      console.error('Failed to start mock event generator:', error);
      throw error;
    }
  }

  async publishInitialData(batchSize: number) {
    const routingCount = Math.floor(batchSize * 0.4); // 40% routing decisions
    const actionCount = batchSize - routingCount; // 60% actions

    // Publish routing decisions
    for (let i = 0; i < routingCount; i++) {
      const agent = this.agents[i % this.agents.length];
      await this.publishRoutingDecision(agent);

      if ((i + 1) % 10 === 0) {
        process.stdout.write(`\rRouting decisions: ${i + 1}/${routingCount}`);
      }
    }
    console.log(`\n✓ Published ${routingCount} routing decisions`);

    // Publish agent actions
    for (let i = 0; i < actionCount; i++) {
      const agent = this.agents[i % this.agents.length];
      await this.publishAgentAction(agent);

      if ((i + 1) % 10 === 0) {
        process.stdout.write(`\rAgent actions: ${i + 1}/${actionCount}`);
      }
    }
    console.log(`\n✓ Published ${actionCount} agent actions`);
  }

  async publishRandomEvents() {
    const randomAgent = this.agents[Math.floor(Math.random() * this.agents.length)];

    // 60% chance of routing decision
    if (Math.random() < 0.6) {
      await this.publishRoutingDecision(randomAgent);
      console.log(`📊 Routing: ${randomAgent.name}`);
    }

    // 90% chance of agent action
    if (Math.random() < 0.9) {
      await this.publishAgentAction(randomAgent);
      console.log(`🔧 Action: ${randomAgent.name}`);
    }
  }

  async publishRoutingDecision(agent: MockAgentConfig) {
    const confidence = agent.avgConfidence + (Math.random() - 0.5) * 0.1; // ±5% variance
    const routingTime = Math.floor(agent.avgRoutingTime + (Math.random() - 0.5) * 40); // ±20ms variance

    const event = {
      id: crypto.randomUUID(),
      correlation_id: crypto.randomUUID(),
      user_request: this.userRequests[Math.floor(Math.random() * this.userRequests.length)],
      selected_agent: agent.name,
      confidence_score: Math.max(0, Math.min(1, confidence)), // Clamp to 0-1
      routing_strategy:
        this.routingStrategies[Math.floor(Math.random() * this.routingStrategies.length)],
      routing_time_ms: Math.max(10, routingTime), // Minimum 10ms
      alternatives: this.generateAlternatives(agent),
      reasoning: `Selected ${agent.name} based on ${agent.specialization} specialization`,
      timestamp: new Date().toISOString(),
    };

    await this.producer!.send({
      topic: TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
      messages: [{ value: JSON.stringify(event) }],
    });
  }

  async publishAgentAction(agent: MockAgentConfig) {
    const actionTypes = ['tool_call', 'decision', 'success', 'error'];
    const actionType = actionTypes[Math.floor(Math.random() * actionTypes.length)];
    const actionName = agent.actionTypes[Math.floor(Math.random() * agent.actionTypes.length)];

    const event = {
      id: crypto.randomUUID(),
      correlation_id: crypto.randomUUID(),
      agent_name: agent.name,
      action_type: actionType,
      action_name: actionName,
      action_details: {
        specialization: agent.specialization,
        mock: true,
        timestamp: Date.now(),
      },
      debug_mode: Math.random() < 0.1, // 10% debug mode
      duration_ms: Math.floor(10 + Math.random() * 200), // 10-210ms
      timestamp: new Date().toISOString(),
    };

    await this.producer!.send({
      topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
      messages: [{ value: JSON.stringify(event) }],
    });
  }

  private generateAlternatives(selectedAgent: MockAgentConfig): any[] {
    // Generate 2-4 alternative agents with lower confidence
    const count = 2 + Math.floor(Math.random() * 3);
    const alternatives = [];

    const otherAgents = this.agents.filter((a) => a.name !== selectedAgent.name);
    for (let i = 0; i < count && i < otherAgents.length; i++) {
      const alt = otherAgents[i];
      alternatives.push({
        agent: alt.name,
        confidence: Math.random() * 0.7, // Lower than selected agent
        reasoning: `Alternative based on ${alt.specialization}`,
      });
    }

    return alternatives;
  }

  async stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (this.producer && this.isRunning) {
      await this.producer.disconnect();
      this.isRunning = false;
      console.log('Mock event generator stopped');
    }
  }
}

// CLI execution
async function main() {
  const args = process.argv.slice(2);
  const continuous = args.includes('--continuous') || args.includes('-c');
  const initialBatch = parseInt(
    args.find((arg) => arg.startsWith('--batch='))?.split('=')[1] || '100'
  );

  const generator = new MockEventGenerator();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n\n🛑 Shutting down gracefully...');
    await generator.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    await generator.start({ continuous, initialBatch });

    if (!continuous) {
      process.exit(0);
    }
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Auto-start if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { MockEventGenerator };
