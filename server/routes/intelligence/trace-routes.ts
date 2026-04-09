/**
 * Correlation trace discovery and execution trace detail routes.
 * Extracted from intelligence-routes.ts (OMN-5193).
 *
 * Data access: Direct DB (getIntelligenceDb)
 * // TODO(OMN-6111): migrate to ProjectionService
 */
import type { Router } from 'express';
import { sql, desc, eq, inArray } from 'drizzle-orm';
import { getIntelligenceDb } from '../../storage';
import {
  agentRoutingDecisions,
  agentActions,
  agentManifestInjections,
} from '@shared/intelligence-schema';

export function registerTraceRoutes(router: Router): void {
  // GET /traces/recent
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/traces/recent', async (req, res) => {
    try {
      const rawLimit = parseInt(req.query.limit as string, 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;

      const decisions = await getIntelligenceDb()
        .select({
          correlationId: agentRoutingDecisions.correlationId,
          selectedAgent: agentRoutingDecisions.selectedAgent,
          confidenceScore: agentRoutingDecisions.confidenceScore,
          userRequest: agentRoutingDecisions.userRequest,
          routingTimeMs: agentRoutingDecisions.routingTimeMs,
          createdAt: agentRoutingDecisions.createdAt,
        })
        .from(agentRoutingDecisions)
        .orderBy(desc(agentRoutingDecisions.createdAt))
        .limit(limit);

      if (decisions.length === 0) {
        res.json([]); // fallback-ok: no routing decisions recorded yet; empty is a valid result before any agent activity
        return;
      }

      const correlationIds = decisions.map((d) => d.correlationId);

      const [actionCounts, manifestCounts] = await Promise.all([
        getIntelligenceDb()
          .select({
            correlationId: agentActions.correlationId,
            count: sql<number>`count(*)::int`.as('count'),
          })
          .from(agentActions)
          .where(inArray(agentActions.correlationId, correlationIds))
          .groupBy(agentActions.correlationId),

        getIntelligenceDb()
          .select({
            correlationId: agentManifestInjections.correlationId,
            count: sql<number>`count(*)::int`.as('count'),
          })
          .from(agentManifestInjections)
          .where(inArray(agentManifestInjections.correlationId, correlationIds))
          .groupBy(agentManifestInjections.correlationId),
      ]);

      const actionCountMap = new Map(actionCounts.map((r) => [r.correlationId, r.count]));
      const manifestCountMap = new Map(manifestCounts.map((r) => [r.correlationId, r.count]));

      const traces = decisions.map((d) => ({
        correlationId: d.correlationId,
        selectedAgent: d.selectedAgent,
        confidenceScore: parseFloat(d.confidenceScore?.toString() || '0'),
        userRequest: d.userRequest
          ? d.userRequest.length > 120
            ? d.userRequest.slice(0, 120) + '...'
            : d.userRequest
          : null,
        routingTimeMs: d.routingTimeMs,
        createdAt: d.createdAt?.toISOString() || null,
        eventCount:
          1 +
          (actionCountMap.get(d.correlationId) || 0) +
          (manifestCountMap.get(d.correlationId) || 0),
      }));

      res.json(traces);
    } catch (error) {
      console.error('Error fetching recent traces:', error);
      res.status(500).json({
        error: 'Failed to fetch recent traces',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /trace/:correlationId
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/trace/:correlationId', async (req, res) => {
    try {
      const { correlationId } = req.params;

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(correlationId)) {
        res.status(400).json({
          error: 'Invalid correlation ID format',
          message: 'Correlation ID must be a valid UUID',
        });
        return;
      }

      const [actions, manifests] = await Promise.all([
        getIntelligenceDb()
          .select({
            id: agentActions.id,
            agentName: agentActions.agentName,
            actionType: agentActions.actionType,
            actionName: agentActions.actionName,
            actionDetails: agentActions.actionDetails,
            durationMs: agentActions.durationMs,
            createdAt: agentActions.createdAt,
          })
          .from(agentActions)
          .where(eq(agentActions.correlationId, correlationId)),

        getIntelligenceDb()
          .select({
            id: agentManifestInjections.id,
            agentName: agentManifestInjections.agentName,
            manifestVersion: agentManifestInjections.manifestVersion,
            generationSource: agentManifestInjections.generationSource,
            patternsCount: agentManifestInjections.patternsCount,
            infrastructureServices: agentManifestInjections.infrastructureServices,
            totalQueryTimeMs: agentManifestInjections.totalQueryTimeMs,
            routingDecisionId: agentManifestInjections.routingDecisionId,
            createdAt: agentManifestInjections.createdAt,
          })
          .from(agentManifestInjections)
          .where(eq(agentManifestInjections.correlationId, correlationId)),
      ]);

      const routingDecisionIds = manifests
        .filter((m) => m.routingDecisionId)
        .map((m) => m.routingDecisionId as string);

      const routingSelect = {
        id: agentRoutingDecisions.id,
        selectedAgent: agentRoutingDecisions.selectedAgent,
        confidenceScore: agentRoutingDecisions.confidenceScore,
        routingStrategy: agentRoutingDecisions.routingStrategy,
        userRequest: agentRoutingDecisions.userRequest,
        reasoning: agentRoutingDecisions.reasoning,
        alternatives: agentRoutingDecisions.alternatives,
        routingTimeMs: agentRoutingDecisions.routingTimeMs,
        createdAt: agentRoutingDecisions.createdAt,
      };

      const [directDecisions, fkDecisions] = await Promise.all([
        getIntelligenceDb()
          .select(routingSelect)
          .from(agentRoutingDecisions)
          .where(eq(agentRoutingDecisions.correlationId, correlationId)),

        routingDecisionIds.length > 0
          ? getIntelligenceDb()
              .select(routingSelect)
              .from(agentRoutingDecisions)
              .where(inArray(agentRoutingDecisions.id, routingDecisionIds))
          : Promise.resolve([]),
      ]);

      const seenIds = new Set<string>();
      const routingDecisions: typeof directDecisions = [];
      for (const d of [...directDecisions, ...fkDecisions]) {
        if (!seenIds.has(d.id)) {
          seenIds.add(d.id);
          routingDecisions.push(d);
        }
      }

      const routingEvents = routingDecisions.map((d) => ({
        id: d.id,
        eventType: 'routing' as const,
        timestamp: d.createdAt?.toISOString() || new Date().toISOString(),
        agentName: d.selectedAgent,
        details: {
          userRequest: d.userRequest,
          confidenceScore: parseFloat(d.confidenceScore?.toString() || '0'),
          routingStrategy: d.routingStrategy,
          reasoning: d.reasoning,
          alternatives: d.alternatives,
        },
        durationMs: d.routingTimeMs || undefined,
      }));

      const actionEvents = actions.map((a) => ({
        id: a.id,
        eventType: 'action' as const,
        timestamp: a.createdAt?.toISOString() || new Date().toISOString(),
        agentName: a.agentName,
        details: {
          actionType: a.actionType,
          actionName: a.actionName,
          actionDetails: a.actionDetails,
        },
        durationMs: a.durationMs || undefined,
      }));

      const manifestEvents = manifests.map((m) => ({
        id: m.id,
        eventType: 'manifest' as const,
        timestamp: m.createdAt?.toISOString() || new Date().toISOString(),
        agentName: m.agentName,
        details: {
          manifestVersion: m.manifestVersion,
          generationSource: m.generationSource,
          patternsCount: m.patternsCount,
          infrastructureServices: m.infrastructureServices,
        },
        durationMs: m.totalQueryTimeMs || undefined,
      }));

      const allEvents = [...routingEvents, ...actionEvents, ...manifestEvents];
      allEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      const summary = {
        totalEvents: allEvents.length,
        routingDecisions: routingEvents.length,
        actions: actionEvents.length,
        errors: 0,
        totalDurationMs: allEvents.reduce((sum, e) => sum + (e.durationMs || 0), 0),
      };

      res.json({
        correlationId,
        events: allEvents,
        summary,
      });
    } catch (error) {
      console.error('Error fetching trace:', error);
      res.status(500).json({
        error: 'Failed to fetch trace',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /execution/:correlationId
  // TODO(OMN-6111): migrate to ProjectionService
  router.get('/execution/:correlationId', async (req, res) => {
    try {
      const { correlationId } = req.params;

      // Fetch routing decision
      const routingDecision = await getIntelligenceDb()
        .select()
        .from(agentRoutingDecisions)
        .where(eq(agentRoutingDecisions.correlationId, correlationId))
        .limit(1);

      const actions = await getIntelligenceDb()
        .select()
        .from(agentActions)
        .where(eq(agentActions.correlationId, correlationId))
        .orderBy(agentActions.createdAt);

      if (!routingDecision || routingDecision.length === 0) {
        return res.status(404).json({
          error: 'Execution not found',
          message: `No execution found for correlation ID: ${correlationId}`,
        });
      }

      const decision = routingDecision[0];

      const totalActions = actions.length;
      const totalDuration =
        actions.reduce((sum, a) => sum + (a.durationMs || 0), 0) + (decision.routingTimeMs || 0);
      const startTime = decision.createdAt;
      const endTime =
        actions.length > 0 ? actions[actions.length - 1].createdAt : decision.createdAt;
      const status =
        (decision.executionSucceeded ?? decision.actualSuccess ?? true) ? 'success' : 'failed';

      const response = {
        correlationId,
        routingDecision: {
          userRequest: decision.userRequest,
          selectedAgent: decision.selectedAgent,
          confidenceScore: parseFloat(decision.confidenceScore?.toString() || '0'),
          routingStrategy: decision.routingStrategy,
          routingTimeMs: decision.routingTimeMs,
          timestamp: decision.createdAt,
          actualSuccess: decision.executionSucceeded ?? decision.actualSuccess,
          alternatives: decision.alternatives || [],
          reasoning: decision.reasoning,
          triggerConfidence: decision.triggerConfidence
            ? parseFloat(decision.triggerConfidence.toString())
            : null,
          contextConfidence: decision.contextConfidence
            ? parseFloat(decision.contextConfidence.toString())
            : null,
          capabilityConfidence: decision.capabilityConfidence
            ? parseFloat(decision.capabilityConfidence.toString())
            : null,
          historicalConfidence: decision.historicalConfidence
            ? parseFloat(decision.historicalConfidence.toString())
            : null,
        },
        actions: actions.map((action) => ({
          id: action.id,
          actionType: action.actionType,
          actionName: action.actionName,
          actionDetails: action.actionDetails,
          durationMs: action.durationMs,
          timestamp: action.createdAt,
          status: 'success',
        })),
        summary: {
          totalActions,
          totalDuration,
          status,
          startTime,
          endTime,
        },
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching execution trace:', error);
      res.status(500).json({
        error: 'Failed to fetch execution trace',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}
