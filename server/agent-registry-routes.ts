import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { AgentExecutionTracker } from './agent-execution-tracker';
import { PolymorphicAgentIntegration } from './polymorphic-agent-integration';
import { agentRoutingProjection } from './projection-bootstrap';

// ESM-compatible __dirname (esbuild --format=esm strips CJS globals)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// Get performance data from execution tracker
function getPerformanceData(agentName: string) {
  return AgentExecutionTracker.getAgentPerformanceMetrics(agentName);
}

// Load agent registry from YAML file
function loadAgentRegistry() {
  try {
    // Resolve path: env var > $OMNI_HOME-relative > __dirname-relative fallback (OMN-7994)
    const agentDefinitionsPath =
      process.env.AGENT_DEFINITIONS_PATH ||
      (process.env.OMNI_HOME
        ? path.join(process.env.OMNI_HOME, 'omniclaude/plugins/onex/agents/configs')
        : path.resolve(__dirname, '../../omniclaude/plugins/onex/agents/configs'));
    const registryPath = path.join(agentDefinitionsPath, 'agent-registry.yaml');

    const fileContents = fs.readFileSync(registryPath, 'utf8');
    const registry = yaml.load(fileContents) as any;
    return registry;
  } catch (error) {
    console.error('Error loading agent registry:', error);
    return null;
  }
}

// Transform registry agent to API format
function transformAgentToAPI(agentData: any, agentName: string): any {
  const performance = getPerformanceData(agentName);

  // Extract capabilities from agent definition
  const capabilities = [];
  if (agentData.capabilities) {
    for (const [key, value] of Object.entries(agentData.capabilities)) {
      if (typeof value === 'object' && value !== null) {
        const capObj = value as any;
        capabilities.push({
          name: capObj.name || key,
          description: capObj.description || capObj.purpose || `Capability for ${key}`,
          category: capObj.category || 'general',
          level: capObj.level || 'intermediate',
        });
      }
    }
  }

  return {
    id: agentData.name || agentName,
    name: agentData.name || agentName,
    title: agentData.title || agentData.agent_identity?.title || agentName,
    description:
      agentData.description || agentData.agent_identity?.description || 'No description available',
    category: agentData.category || 'general',
    color: agentData.color || agentData.agent_identity?.color || 'blue',
    priority: agentData.priority || 'medium',
    capabilities,
    activationTriggers: agentData.activation_triggers || agentData.triggers || [],
    domainContext: agentData.domain_context || agentData.domain || 'general',
    specializationLevel: agentData.specialization_level || 'specialist',
    performance,
    status: agentData.status || 'active',
    lastUpdated: agentData.last_updated || new Date().toISOString(),
    version: agentData.version || '1.0.0',
    dependencies: agentData.dependencies || [],
    tags: agentData.tags || [],
  };
}

// Get all agents
router.get('/agents', (req, res) => {
  try {
    const { category, search, status, priority } = req.query;

    const registry = loadAgentRegistry();
    if (!registry || !registry.agents) {
      return res.status(500).json({ error: 'Agent registry not found', agents: [] });
    }

    let agents = Object.entries(registry.agents).map(([key, agentData]: [string, any]) => {
      return transformAgentToAPI(agentData, key);
    });

    // Apply filters
    if (category && category !== 'all') {
      agents = agents.filter((agent) => agent.category === category);
    }

    if (search) {
      const searchLower = (search as string).toLowerCase();
      agents = agents.filter(
        (agent) =>
          agent.name.toLowerCase().includes(searchLower) ||
          agent.title.toLowerCase().includes(searchLower) ||
          agent.description.toLowerCase().includes(searchLower) ||
          agent.tags.some((tag: string) => tag.toLowerCase().includes(searchLower))
      );
    }

    if (status) {
      agents = agents.filter((agent) => agent.status === status);
    }

    if (priority) {
      agents = agents.filter((agent) => agent.priority === priority);
    }

    res.json(agents);
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

// Get specific agent
router.get('/agents/:agentId', (req, res) => {
  try {
    const { agentId } = req.params;

    const registry = loadAgentRegistry();
    if (!registry || !registry.agents) {
      return res.status(500).json({ error: 'Failed to load agent registry' });
    }

    const agentData = registry.agents[agentId];
    if (!agentData) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agent = transformAgentToAPI(agentData, agentId);
    res.json(agent);
  } catch (error) {
    console.error('Error fetching agent:', error);
    res.status(500).json({ error: 'Failed to fetch agent' });
  }
});

// Get agent categories
router.get('/categories', (req, res) => {
  try {
    const registry = loadAgentRegistry();
    if (!registry || !registry.categories) {
      return res.status(500).json({ error: 'Failed to load agent registry' });
    }

    const categories = Object.entries(registry.categories).map(
      ([key, categoryData]: [string, any]) => ({
        name: key,
        description: categoryData.description || `Agents for ${key}`,
        count: categoryData.count || 0,
        priority: categoryData.priority || 'medium',
        color: categoryData.color || 'blue',
      })
    );

    res.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Get agent capabilities
router.get('/capabilities', (req, res) => {
  try {
    const { category } = req.query;

    const registry = loadAgentRegistry();
    if (!registry || !registry.agents) {
      return res.status(500).json({ error: 'Failed to load agent registry' });
    }

    let agents = Object.entries(registry.agents).map(([key, agentData]: [string, any]) => {
      return transformAgentToAPI(agentData, key);
    });

    if (category && category !== 'all') {
      agents = agents.filter((agent) => agent.category === category);
    }

    const allCapabilities = agents.flatMap((agent) => agent.capabilities);
    const uniqueCapabilities = Array.from(new Set(allCapabilities.map((cap) => cap.name))).map(
      (name) => allCapabilities.find((cap) => cap.name === name)!
    );

    res.json(uniqueCapabilities);
  } catch (error) {
    console.error('Error fetching capabilities:', error);
    res.status(500).json({ error: 'Failed to fetch capabilities' });
  }
});

// Get agent performance metrics
router.get('/performance', (req, res) => {
  try {
    const { agentId } = req.query;

    if (agentId) {
      // Get performance for specific agent
      const performance = getPerformanceData(agentId as string);
      if (!performance) {
        return res.status(404).json({ error: 'Agent performance data not found' });
      }
      res.json(performance);
    } else {
      // Get performance overview
      const registry = loadAgentRegistry();
      if (!registry || !registry.agents) {
        return res.status(500).json({ error: 'Failed to load agent registry' });
      }

      const agents = Object.entries(registry.agents).map(([key, agentData]: [string, any]) => {
        return transformAgentToAPI(agentData, key);
      });

      const performanceOverview = {
        totalAgents: agents.length,
        activeAgents: agents.filter((a) => a.status === 'active').length,
        avgSuccessRate:
          agents.reduce((sum, a) => sum + a.performance.successRate, 0) / agents.length,
        avgEfficiency: agents.reduce((sum, a) => sum + a.performance.efficiency, 0) / agents.length,
        totalRuns: agents.reduce((sum, a) => sum + a.performance.totalRuns, 0),
        topPerformers: agents
          .sort((a, b) => b.performance.efficiency - a.performance.efficiency)
          .slice(0, 10)
          .map((agent) => ({
            id: agent.id,
            name: agent.title,
            efficiency: agent.performance.efficiency,
            successRate: agent.performance.successRate,
          })),
      };

      res.json(performanceOverview);
    }
  } catch (error) {
    console.error('Error fetching performance:', error);
    res.status(500).json({ error: 'Failed to fetch performance data' });
  }
});

// High-level agent summary for dashboards
router.get('/summary', (req, res) => {
  try {
    const registry = loadAgentRegistry();
    if (!registry || !registry.agents) {
      // Return empty summary when registry file is unavailable (not a server error)
      return res.json({
        totalAgents: 0,
        activeAgents: 0,
        totalRuns: 0,
        successRate: 0,
        avgExecutionTime: 0,
        totalSavings: 0,
      });
    }

    const agents = Object.entries(registry.agents).map(([key, agentData]: [string, any]) => {
      return transformAgentToAPI(agentData, key);
    });

    const totalAgents = agents.length;
    const activeAgents = agents.filter((a) => a.status === 'active').length;
    const totalRuns = agents.reduce((sum, a) => sum + (a.performance?.totalRuns || 0), 0);
    const avgExecutionTime = (() => {
      const times = agents
        .map((a) => a.performance?.avgExecutionTime)
        .filter((v: any) => typeof v === 'number');
      return times.length ? times.reduce((s: number, v: number) => s + v, 0) / times.length : 0;
    })();
    const successRates = agents
      .map((a) => a.performance?.successRate)
      .filter((v: any) => typeof v === 'number');
    const successRate = successRates.length
      ? successRates.reduce((s: number, v: number) => s + v, 0) / successRates.length
      : 0;

    res.json({
      totalAgents,
      activeAgents,
      totalRuns,
      successRate,
      avgExecutionTime,
      totalSavings: 0,
    });
  } catch (error) {
    console.error('Error fetching agent summary:', error);
    res.status(500).json({ error: 'Failed to fetch agent summary' });
  }
});

// Get routing intelligence data from DB via AgentRoutingProjection (OMN-2750)
router.get('/routing', async (req, res) => {
  try {
    const payload = await agentRoutingProjection.ensureFresh();

    const { summary, recentDecisions, strategyBreakdown, agentBreakdown } = payload;

    const routingStrategies = strategyBreakdown.map((s) => ({
      name: s.name,
      usage: s.usage,
      accuracy: s.accuracy,
    }));

    const performanceByCategory = agentBreakdown.map((a) => ({
      category: a.agent,
      avgConfidence: a.avgConfidence,
      avgTime: a.avgTime,
    }));

    const accuracy =
      summary.totalDecisions > 0 ? Math.round(summary.avgConfidence * 100 * 10) / 10 : 0;

    res.json({
      accuracy,
      avgRoutingTime: Math.round(summary.avgRoutingTime),
      avgAlternatives: 0, // Not tracked in current schema
      totalDecisions: summary.totalDecisions,
      recentDecisions,
      routingStrategies,
      performanceByCategory,
      source: summary.totalDecisions > 0 ? 'database' : 'empty',
    });
  } catch (error) {
    console.error('Error fetching routing data:', error);
    res.status(500).json({ error: 'Failed to fetch routing data' });
  }
});

// Execute agent
router.post('/agents/:agentId/execute', (req, res) => {
  try {
    const { agentId } = req.params;
    const { query, context, routingDecision } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Get agent name from registry
    const registry = loadAgentRegistry();
    const agentData = registry?.agents?.[agentId];
    const agentName = agentData?.title || agentId;

    // Start tracking execution
    const execution = AgentExecutionTracker.startExecution(
      agentId,
      agentName,
      query,
      context,
      routingDecision
    );

    // In production, this would trigger the actual agent execution
    // For now, we'll simulate completion after a delay
    setTimeout(
      () => {
        const result = {
          success: Math.random() > 0.1, // 90% success rate
          output: `Execution completed for: ${query}`,
          qualityScore: 7 + Math.random() * 3,
          metrics: {
            tokensUsed: Math.floor(500 + Math.random() * 2000),
            computeUnits: 1 + Math.random() * 5,
            cost: 0.05 + Math.random() * 0.2,
          },
        };

        AgentExecutionTracker.updateExecutionStatus(execution.id, 'completed', result);
      },
      2000 + Math.random() * 3000
    ); // 2-5 second delay

    res.json({
      id: execution.id,
      agentId,
      agentName,
      query,
      context,
      status: execution.status,
      startedAt: execution.startedAt,
      estimatedDuration: '2-5 minutes',
    });
  } catch (error) {
    console.error('Error executing agent:', error);
    res.status(500).json({ error: 'Failed to execute agent' });
  }
});

// Get agent execution status
router.get('/executions/:executionId', (req, res) => {
  try {
    const { executionId } = req.params;

    const execution = AgentExecutionTracker.getExecution(executionId);
    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    res.json(execution);
  } catch (error) {
    console.error('Error fetching execution status:', error);
    res.status(500).json({ error: 'Failed to fetch execution status' });
  }
});

// Get recent executions
router.get('/executions', (req, res) => {
  try {
    const { agentId, limit = 20 } = req.query;

    let executions;
    if (agentId) {
      executions = AgentExecutionTracker.getExecutionsForAgent(agentId as string, Number(limit));
    } else {
      executions = AgentExecutionTracker.getRecentExecutions(Number(limit));
    }

    res.json(executions);
  } catch (error) {
    console.error('Error fetching executions:', error);
    res.status(500).json({ error: 'Failed to fetch executions' });
  }
});

// Get execution statistics
router.get('/executions/stats', (req, res) => {
  try {
    const { agentId, timeRange } = req.query;

    let timeRangeObj;
    if (timeRange) {
      const days = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 7;
      const end = new Date();
      const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
      timeRangeObj = { start, end };
    }

    const stats = AgentExecutionTracker.getExecutionStats(agentId as string, timeRangeObj);

    res.json(stats);
  } catch (error) {
    console.error('Error fetching execution stats:', error);
    res.status(500).json({ error: 'Failed to fetch execution stats' });
  }
});

// Polymorphic Agent Integration Routes
// Mock simulation endpoints removed in OMN-7730. These return 501 until
// a real routing backend is wired.

router.post('/routing/decide', (_req, res) => {
  res.status(501).json({
    error: 'Not implemented',
    message: 'Routing decision simulation removed. Real routing backend not yet wired.',
  });
});

router.post('/routing/execute', (_req, res) => {
  res.status(501).json({
    error: 'Not implemented',
    message: 'Routing execution simulation removed. Real routing backend not yet wired.',
  });
});

// Get routing statistics via AgentRoutingProjection (OMN-2750)
router.get('/routing/stats', async (req, res) => {
  try {
    const payload = await agentRoutingProjection.ensureFresh();
    const { summary, strategyBreakdown, agentBreakdown } = payload;

    const strategyMap: Record<string, number> = {};
    for (const s of strategyBreakdown) {
      strategyMap[s.name] = s.count;
    }
    const agentMap: Record<string, number> = {};
    for (const a of agentBreakdown) {
      agentMap[a.agent] = a.count;
    }

    res.json({
      totalDecisions: summary.totalDecisions,
      avgConfidence: summary.avgConfidence,
      avgRoutingTime: summary.avgRoutingTime,
      successRate: summary.successRate,
      strategyBreakdown: strategyMap,
      agentBreakdown: agentMap,
      source: summary.totalDecisions > 0 ? 'database' : 'in-memory',
    });
  } catch (error) {
    console.error('Error fetching routing stats:', error);
    res.status(500).json({ error: 'Failed to fetch routing statistics' });
  }
});

// Get agent performance comparison via AgentRoutingProjection (OMN-2750)
router.get('/routing/performance', async (req, res) => {
  try {
    const payload = await agentRoutingProjection.ensureFresh();

    if (payload.agentBreakdown.length === 0) {
      // No DB data — fall back to in-memory tracker
      const performance = PolymorphicAgentIntegration.getAgentPerformanceComparison();
      return res.json(performance);
    }

    const performance = payload.agentBreakdown.map((row) => ({
      agentId: row.agent,
      agentName: row.agent.replace('agent-', '').replace(/-/g, ' '),
      performance: AgentExecutionTracker.getAgentPerformanceMetrics(row.agent),
      routingStats: {
        avgConfidence: row.avgConfidence / 100, // Convert back to 0-1 scale
        avgRoutingTime: parseFloat(row.avgTime),
        totalDecisions: row.totalDecisions,
        successRate: row.successRate,
      },
      source: 'database',
    }));

    res.json(performance);
  } catch (error) {
    console.error('Error fetching agent performance:', error);
    res.status(500).json({ error: 'Failed to fetch agent performance' });
  }
});

export default router;
