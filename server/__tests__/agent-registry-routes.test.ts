import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import yaml from 'js-yaml';

const trackerMocks = {
  startExecution: vi.fn(),
  updateExecutionStatus: vi.fn(),
  getExecution: vi.fn(),
  getExecutionsForAgent: vi.fn(),
  getRecentExecutions: vi.fn(),
  getExecutionStats: vi.fn(),
  getAgentPerformanceMetrics: vi.fn(),
};

const polymorphicMocks = {
  simulateRoutingDecision: vi.fn(),
  executeAgent: vi.fn(),
  getRoutingStatistics: vi.fn(),
  getAgentPerformanceComparison: vi.fn(),
};

vi.mock('../agent-execution-tracker', () => ({
  AgentExecutionTracker: trackerMocks,
}));

vi.mock('../polymorphic-agent-integration', () => ({
  PolymorphicAgentIntegration: polymorphicMocks,
}));

const projectionMocks = {
  ensureFresh: vi.fn(),
};

vi.mock('../projection-bootstrap', () => ({
  agentRoutingProjection: projectionMocks,
}));

describe('agent-registry routes', () => {
  let app: express.Express;
  let currentRegistry: any;
  let routerModule: express.Router;
  const originalEnv = { ...process.env };

  const readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
  const yamlLoadSpy = vi.spyOn(yaml, 'load');

  const SAMPLE_METRICS = {
    totalRuns: 25,
    successRate: 92,
    avgExecutionTime: 45,
    avgQualityScore: 8.7,
    lastUsed: '2024-01-01T00:00:00Z',
    popularity: 80,
    efficiency: 88,
  };

  const clone = <T>(value: T): T =>
    typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));

  const SAMPLE_REGISTRY = {
    agents: {
      'agent-alpha': {
        name: 'Agent Alpha',
        title: 'Alpha Specialist',
        description: 'Handles alpha tasks',
        category: 'development',
        status: 'active',
        priority: 'high',
        color: 'green',
        tags: ['alpha', 'dev'],
        capabilities: {
          strategy: {
            name: 'Strategy',
            description: 'Strategic planning',
            category: 'planning',
            level: 'expert',
          },
        },
      },
      'agent-beta': {
        name: 'Agent Beta',
        title: 'Beta Analyst',
        description: 'Analyzes beta metrics',
        category: 'analysis',
        status: 'inactive',
        priority: 'medium',
        tags: ['beta'],
        capabilities: {
          analytics: {
            name: 'Analytics',
            description: 'Performs analytics',
            category: 'analysis',
            level: 'intermediate',
          },
        },
      },
    },
    categories: {
      development: {
        description: 'Development agents',
        count: 5,
        color: 'blue',
        priority: 'high',
      },
      analysis: {
        description: 'Analysis agents',
        count: 3,
      },
    },
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env = { ...originalEnv };
    process.env.AGENT_DEFINITIONS_PATH = '/fake/definitions';

    currentRegistry = clone(SAMPLE_REGISTRY);

    readFileSyncSpy.mockImplementation(() => 'yaml-content');
    yamlLoadSpy.mockImplementation(() => currentRegistry);

    trackerMocks.getAgentPerformanceMetrics.mockImplementation((agentId: string) => ({
      ...SAMPLE_METRICS,
      totalRuns: agentId === 'agent-beta' ? 15 : SAMPLE_METRICS.totalRuns,
      successRate: agentId === 'agent-beta' ? 85 : SAMPLE_METRICS.successRate,
      efficiency: agentId === 'agent-beta' ? 72 : SAMPLE_METRICS.efficiency,
    }));
    trackerMocks.getExecution.mockReturnValue({ id: 'exec-1', status: 'completed' });
    trackerMocks.getExecutionsForAgent.mockReturnValue([{ id: 'exec-2' }]);
    trackerMocks.getRecentExecutions.mockReturnValue([{ id: 'exec-3' }]);
    trackerMocks.getExecutionStats.mockReturnValue({ total: 10 });
    trackerMocks.startExecution.mockReturnValue({
      id: 'exec-123',
      status: 'executing',
      startedAt: '2024-01-01T00:00:00Z',
    });

    polymorphicMocks.simulateRoutingDecision.mockResolvedValue({
      selectedAgent: 'agent-alpha',
      confidence: 0.92,
    });
    polymorphicMocks.executeAgent.mockResolvedValue({ result: 'ok' });
    polymorphicMocks.getRoutingStatistics.mockReturnValue({ accuracy: 95 });
    polymorphicMocks.getAgentPerformanceComparison.mockReturnValue({
      comparison: 'data',
    });

    projectionMocks.ensureFresh.mockResolvedValue({
      summary: {
        totalDecisions: 100,
        avgConfidence: 0.9,
        avgRoutingTime: 45,
        successRate: 92,
        successCount: 92,
      },
      recentDecisions: [
        {
          id: '1',
          query: 'test query',
          agent: 'agent-alpha',
          confidence: 90,
          time: '45ms',
          timestamp: '2024-01-01T00:00:00Z',
        },
      ],
      strategyBreakdown: [
        { name: 'enhanced_fuzzy_matching', count: 65, usage: 65, accuracy: 96.2 },
      ],
      agentBreakdown: [
        {
          agent: 'agent-alpha',
          count: 50,
          avgConfidence: 90,
          avgTime: '45ms',
          totalDecisions: 50,
          successCount: 46,
          successRate: 92,
        },
      ],
    });

    const router = (await import('../agent-registry-routes')).default;
    routerModule = router;
    app = express();
    app.use(express.json());
    app.use('/registry', router);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns transformed agents with filters applied', async () => {
    const response = await request(app).get('/registry/agents?category=development&search=alpha');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      id: 'Agent Alpha',
      title: 'Alpha Specialist',
      performance: expect.objectContaining({ totalRuns: SAMPLE_METRICS.totalRuns }),
    });
  });

  it('returns 500 when registry cannot be loaded', async () => {
    currentRegistry = null;
    const response = await request(app).get('/registry/agents');
    expect(response.status).toBe(500);
  });

  it('returns specific agent or 404', async () => {
    let response = await request(app).get('/registry/agents/agent-alpha');
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('Agent Alpha');

    response = await request(app).get('/registry/agents/unknown');
    expect(response.status).toBe(404);
  });

  it('returns categories list', async () => {
    const response = await request(app).get('/registry/categories');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body[0]).toMatchObject({ name: 'development', count: 5 });
  });

  it('returns unique capabilities optionally filtered by category', async () => {
    let response = await request(app).get('/registry/capabilities');
    expect(response.status).toBe(200);
    expect(response.body.map((cap: any) => cap.name).sort()).toEqual(['Analytics', 'Strategy']);

    response = await request(app).get('/registry/capabilities?category=analysis');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].name).toBe('Analytics');
  });

  it('returns agent-specific performance metrics', async () => {
    const response = await request(app).get('/registry/performance?agentId=agent-alpha');
    expect(response.status).toBe(200);
    expect(trackerMocks.getAgentPerformanceMetrics).toHaveBeenCalledWith('agent-alpha');
    expect(response.body.totalRuns).toBe(SAMPLE_METRICS.totalRuns);
  });

  it('returns performance overview when no agentId provided', async () => {
    const response = await request(app).get('/registry/performance');
    expect(response.status).toBe(200);
    expect(response.body.totalAgents).toBe(2);
    expect(response.body.topPerformers[0]).toHaveProperty('efficiency');
  });

  it('returns 404 when performance data missing', async () => {
    trackerMocks.getAgentPerformanceMetrics.mockReturnValueOnce(null);
    const response = await request(app).get('/registry/performance?agentId=missing');
    expect(response.status).toBe(404);
  });

  const getRouteHandler = (method: string, routePath: string) => {
    const layer = routerModule.stack.find(
      (entry: any) => entry.route && entry.route.path === routePath && entry.route.methods[method]
    );
    if (!layer) {
      throw new Error(`Route handler for [${method.toUpperCase()}] ${routePath} not found`);
    }
    return layer.route.stack[0].handle;
  };

  it('starts execution for an agent and schedules completion', async () => {
    const handler = getRouteHandler('post', '/agents/:agentId/execute');
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((
      cb: (...args: any[]) => void
    ) => {
      cb();
      return 0 as any;
    }) as any);

    const req: any = {
      params: { agentId: 'agent-alpha' },
      body: { query: 'Test query', context: { foo: 'bar' }, routingDecision: { decision: true } },
    };
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    await handler(req, res, vi.fn());

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'exec-123', status: 'executing' })
    );
    expect(trackerMocks.startExecution).toHaveBeenCalledWith(
      'agent-alpha',
      'Alpha Specialist',
      'Test query',
      { foo: 'bar' },
      { decision: true }
    );
    expect(trackerMocks.updateExecutionStatus).toHaveBeenCalledWith(
      'exec-123',
      'completed',
      expect.any(Object)
    );

    setTimeoutSpy.mockRestore();
  });

  it('returns execution by id or 404 when missing', async () => {
    trackerMocks.getExecution.mockReturnValueOnce({ id: 'exec-1' });
    let response = await request(app).get('/registry/executions/exec-1');
    expect(response.status).toBe(200);

    trackerMocks.getExecution.mockReturnValueOnce(null);
    response = await request(app).get('/registry/executions/missing');
    expect(response.status).toBe(404);
  });

  it('lists executions by agent or recent executions', async () => {
    let response = await request(app).get('/registry/executions?agentId=agent-alpha&limit=5');
    expect(response.status).toBe(200);
    expect(trackerMocks.getExecutionsForAgent).toHaveBeenCalledWith('agent-alpha', 5);

    response = await request(app).get('/registry/executions?limit=2');
    expect(response.status).toBe(200);
    expect(trackerMocks.getRecentExecutions).toHaveBeenCalledWith(2);
  });

  it('returns execution stats with optional time range', async () => {
    const handler = getRouteHandler('get', '/executions/stats');
    const req: any = {
      query: { agentId: 'agent-alpha', timeRange: '7d' },
    };
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    await handler(req, res, vi.fn());

    expect(trackerMocks.getExecutionStats).toHaveBeenCalledWith(
      'agent-alpha',
      expect.objectContaining({ start: expect.any(Date), end: expect.any(Date) })
    );
    expect(res.json).toHaveBeenCalledWith({ total: 10 });
  });

  it('returns 501 for routing decide and execute endpoints (mock removed)', async () => {
    const decideHandler = getRouteHandler('post', '/routing/decide');
    const executeHandler = getRouteHandler('post', '/routing/execute');

    const decideRes: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    decideHandler({} as any, decideRes, vi.fn());
    expect(decideRes.status).toHaveBeenCalledWith(501);
    expect(decideRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Not implemented' })
    );

    const executeRes: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    executeHandler({} as any, executeRes, vi.fn());
    expect(executeRes.status).toHaveBeenCalledWith(501);
    expect(executeRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Not implemented' })
    );
  });

  it('returns routing statistics and performance comparison', async () => {
    let response = await request(app).get('/registry/routing/stats');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('totalDecisions', 100);
    expect(response.body).toHaveProperty('avgConfidence', 0.9);
    expect(response.body).toHaveProperty('source', 'database');

    response = await request(app).get('/registry/routing/performance');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body[0]).toHaveProperty('agentId', 'agent-alpha');
    expect(response.body[0]).toHaveProperty('source', 'database');
  });
});
