/**
 * API Response Schemas - Zod Validation
 *
 * This file contains Zod schemas for all API responses consumed by data sources.
 * Following the pattern from shared/intelligence-schema.ts for consistency.
 *
 * Purpose: Runtime validation of API responses to prevent malformed data from crashing the UI.
 * Validation failures gracefully fall back to mock data with error logging.
 */

import { z } from 'zod';

// ===========================
// Agent Operations Schemas
// ===========================

export const serviceStatusSchema = z.object({
  name: z.string(),
  status: z.string(),
  latency: z.number().optional(),
});

export const healthStatusSchema = z.object({
  status: z.string(),
  services: z.array(serviceStatusSchema),
});

export const agentSummarySchema = z.object({
  totalAgents: z.number().min(0),
  activeAgents: z.number().min(0),
  totalRuns: z.number().min(0),
  successRate: z.number().min(0).max(100),
  avgExecutionTime: z.number().min(0),
});

export const recentActionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  action: z.string(),
  status: z.string(),
  timestamp: z.string(),
  duration: z.number().optional(),
});

export const chartDataPointSchema = z.object({
  time: z.string(),
  value: z.number(),
});

export const operationStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['running', 'idle']),
  count: z.number().min(0),
  avgTime: z.string(),
});

// Per-agent metrics from API (snake_case format from backend)
export const agentMetricsApiSchema = z.object({
  agent: z.string(),
  totalRequests: z.number().min(0),
  avgRoutingTime: z.number().min(0),
  successRate: z.number().optional(), // Can be decimal (0-1) or percentage (0-100)
  avgConfidence: z.number().min(0).max(1).optional(), // Legacy field, must be normalized to 0-1
  avgTokens: z.number().optional(),
});

// Execution schema for /api/agents/executions endpoint
export const executionSchema = z.object({
  id: z.string(),
  query: z.string().optional(),
  actionName: z.string().optional(),
  agentName: z.string().optional(),
  agentId: z.string().optional(),
  status: z.enum(['completed', 'executing', 'failed', 'pending']),
  startedAt: z.string(),
});

// ===========================
// Pattern Learning Schemas
// ===========================

export const discoveredPatternSchema = z.object({
  name: z.string(),
  file_path: z.string(),
  createdAt: z.string(),
  metadata: z
    .object({
      createdAt: z.string(),
    })
    .optional(),
});

export const patternSummarySchema = z.object({
  totalPatterns: z.number().min(0),
  newPatternsToday: z.number().min(0),
  avgQualityScore: z.number().min(0).max(1),
  activeLearningCount: z.number().min(0),
});

export const patternTrendSchema = z.object({
  period: z.string(),
  manifestsGenerated: z.number().min(0),
  avgPatternsPerManifest: z.number().min(0),
  avgQueryTimeMs: z.number().min(0),
});

export const qualityTrendSchema = z.object({
  period: z.string(),
  avgQuality: z.number().min(0),
  manifestCount: z.number().min(0),
});

export const patternSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  quality: z.number().min(0).max(1),
  usage: z.number().min(0),
  trend: z.enum(['up', 'down', 'stable']),
  trendPercentage: z.number(),
  category: z.string(),
  language: z.string().nullable().optional(),
});

export const languageBreakdownSchema = z.object({
  language: z.string(),
  count: z.number().min(0),
  percentage: z.number().min(0).max(100),
});

// API response format (snake_case)
export const languageBreakdownApiSchema = z.object({
  language: z.string(),
  pattern_count: z.number().min(0),
});

// ===========================
// PATLEARN Lifecycle Model
// ===========================

export const lifecycleStateSchema = z.enum([
  'candidate', // Initial discovery, below threshold
  'provisional', // Above threshold, pending validation
  'validated', // Confirmed as learned pattern
  'deprecated', // Superseded or invalidated
  'requested', // Raw pipeline event, not yet processed
]);

// ===========================
// PATLEARN Scoring with Evidence
// ===========================

export const scoringEvidenceSchema = z.object({
  labelAgreement: z
    .object({
      score: z.number().min(0).max(1).optional(),
      matchedLabels: z.array(z.string()).optional(),
      totalLabels: z.number().optional(),
      disagreements: z.array(z.string()).optional(),
    })
    .optional(),
  clusterCohesion: z
    .object({
      score: z.number().min(0).max(1).optional(),
      clusterId: z.string().optional(),
      memberCount: z.number().optional(),
      avgPairwiseSimilarity: z.number().optional(),
      medoidId: z.string().optional(),
    })
    .optional(),
  frequencyFactor: z
    .object({
      score: z.number().min(0).max(1).optional(),
      observedCount: z.number().optional(),
      minRequired: z.number().optional(),
      windowDays: z.number().optional(),
    })
    .optional(),
});

// ===========================
// PATLEARN Similarity with Evidence
// ===========================

export const similarityEvidenceSchema = z.object({
  keyword: z.object({
    score: z.number().min(0).max(1),
    intersection: z.array(z.string()),
    unionCount: z.number(),
  }),
  pattern: z.object({
    score: z.number().min(0).max(1),
    matchedIndicators: z.array(z.string()),
    totalIndicators: z.number(),
  }),
  structural: z.object({
    score: z.number().min(0).max(1),
    astDepthDelta: z.number(),
    nodeCountDelta: z.number(),
    complexityDelta: z.number(),
  }),
  label: z.object({
    score: z.number().min(0).max(1),
    matchedLabels: z.array(z.string()),
    totalLabels: z.number(),
  }),
  context: z.object({
    score: z.number().min(0).max(1),
    sharedTokens: z.array(z.string()),
    jaccard: z.number(),
  }),
  composite: z.number().min(0).max(1),
  weights: z.object({
    keyword: z.number().default(0.3),
    pattern: z.number().default(0.25),
    structural: z.number().default(0.2),
    label: z.number().default(0.15),
    context: z.number().default(0.1),
  }),
});

// ===========================
// PATLEARN Similar Pattern Entry
// ===========================

export const similarPatternEntrySchema = z.object({
  patternId: z.string(),
  evidence: similarityEvidenceSchema,
});

// ===========================
// PATLEARN Pattern Signature
// ===========================

export const patternSignatureSchema = z.object({
  hash: z.string().optional(),
  version: z.string().optional(),
  algorithm: z.string().default('sha256').optional(),
  inputs: z.array(z.string()).optional(),
  normalizations: z.array(z.string()).optional(),
  /** Full pattern signature text from omniintelligence (e.g. file paths, tool sequences) */
  pattern_signature: z.string().optional(),
});

// ===========================
// PATLEARN Full Artifact
// ===========================

export const patlearnArtifactSchema = z.object({
  id: z.string(),
  patternId: z.string(),
  patternName: z.string(),
  patternType: z.string(),
  language: z.string().nullable().optional(),
  lifecycleState: lifecycleStateSchema,
  stateChangedAt: z.string().nullable().optional(),
  compositeScore: z.number().min(0).max(1),
  scoringEvidence: scoringEvidenceSchema,
  signature: patternSignatureSchema,
  metrics: z.object({
    processingTimeMs: z.number().optional(),
    inputCount: z.number().optional(),
    clusterCount: z.number().optional(),
    dedupMergeCount: z.number().optional(),
    scoreHistory: z
      .array(
        z.object({
          score: z.number(),
          timestamp: z.string(),
        })
      )
      .optional(),
  }),
  // Optional metadata for pattern descriptions and code examples (demo patterns)
  metadata: z
    .object({
      description: z.string().optional(),
      codeExample: z.string().optional(),
      __demo: z.boolean().optional(),
      __demoCreatedAt: z.string().optional(),
    })
    .passthrough()
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string().nullable().optional(),
});

// ===========================
// PATLEARN Summary (Aggregates)
// ===========================

export const patlearnSummarySchema = z.object({
  totalPatterns: z.number().min(0),
  byState: z.object({
    requested: z.number().min(0),
    candidate: z.number().min(0),
    provisional: z.number().min(0),
    validated: z.number().min(0),
    deprecated: z.number().min(0),
  }),
  avgScores: z.object({
    labelAgreement: z.number().min(0).max(1),
    clusterCohesion: z.number().min(0).max(1),
    frequencyFactor: z.number().min(0).max(1),
    composite: z.number().min(0).max(1),
  }),
  window: z.string(),
  promotionsInWindow: z.number().min(0),
  deprecationsInWindow: z.number().min(0),
});

// ===========================
// Intelligence Analytics Schemas
// ===========================

export const intelligenceMetricsSchema = z.object({
  totalQueries: z.number().min(0),
  avgResponseTime: z.number().min(0),
  successRate: z.number().min(0).max(100),
  fallbackRate: z.number().min(0).max(100),
  costPerQuery: z.number().min(0),
  totalCost: z.number().min(0),
  qualityScore: z.number().min(0).max(10),
  userSatisfaction: z.number().min(0).max(10),
});

export const recentActivitySchema = z.object({
  action: z.string(),
  agent: z.string(),
  time: z.string(),
  status: z.enum(['completed', 'executing', 'failed', 'pending']),
  timestamp: z.string(),
});

export const agentPerformanceSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  totalRuns: z.number().min(0),
  avgResponseTime: z.number().min(0),
  avgExecutionTime: z.number().min(0),
  successRate: z.number().min(0).max(100),
  efficiency: z.number().min(0).max(100),
  avgQualityScore: z.number().min(0).max(10),
  popularity: z.number().min(0),
  costPerSuccess: z.number().min(0).optional(),
  p95Latency: z.number().min(0).optional(),
  lastUsed: z.string(),
});

export const savingsMetricsSchema = z.object({
  totalSavings: z.number(),
  monthlySavings: z.number(),
  weeklySavings: z.number(),
  dailySavings: z.number(),
  intelligenceRuns: z.number().min(0),
  baselineRuns: z.number().min(0),
  avgTokensPerRun: z.number().optional(),
  avgComputePerRun: z.number().optional(),
  costPerToken: z.number().optional(),
  costPerCompute: z.number().optional(),
  efficiencyGain: z.number().optional(),
  timeSaved: z.number(),
});

// ===========================
// Code Intelligence Schemas
// ===========================

export const codeAnalysisTrendSchema = z.object({
  timestamp: z.string(),
  value: z.number(),
});

export const codeAnalysisDataSchema = z.object({
  files_analyzed: z.number().min(0),
  avg_complexity: z.number().min(0),
  code_smells: z.number().min(0),
  security_issues: z.number().min(0),
  complexity_trend: z.array(codeAnalysisTrendSchema).optional(),
  quality_trend: z.array(codeAnalysisTrendSchema).optional(),
});

export const complianceStatusBreakdownSchema = z.object({
  status: z.string(),
  count: z.number().min(0),
  percentage: z.number().min(0).max(100),
});

export const complianceNodeTypeBreakdownSchema = z.object({
  nodeType: z.string(),
  compliantCount: z.number().min(0),
  totalCount: z.number().min(0),
  percentage: z.number().min(0).max(100),
});

export const complianceTrendSchema = z.object({
  period: z.string(),
  compliancePercentage: z.number().min(0).max(100),
  totalFiles: z.number().min(0),
});

export const complianceSummarySchema = z.object({
  totalFiles: z.number().min(0),
  compliantFiles: z.number().min(0),
  nonCompliantFiles: z.number().min(0),
  pendingFiles: z.number().min(0),
  compliancePercentage: z.number().min(0).max(100),
  avgComplianceScore: z.number().min(0).max(1),
});

export const complianceDataSchema = z.object({
  summary: complianceSummarySchema,
  statusBreakdown: z.array(complianceStatusBreakdownSchema),
  nodeTypeBreakdown: z.array(complianceNodeTypeBreakdownSchema),
  trend: z.array(complianceTrendSchema),
});

export const topPatternSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  quality: z.number().min(0).max(1),
  usage: z.number().min(0),
});

export const patternSummaryCodeIntelSchema = z.object({
  totalPatterns: z.number().min(0),
  activePatterns: z.number().min(0),
  qualityScore: z.number().min(0).max(10),
  usageCount: z.number().min(0),
  recentDiscoveries: z.number().min(0),
  topPatterns: z.array(topPatternSchema),
});

// ===========================
// Event Flow Schemas
// ===========================

export const eventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  source: z.string(),
  data: z.any().optional(), // Event data can be any shape and is optional
});

export const eventMetricsSchema = z.object({
  totalEvents: z.number().min(0),
  uniqueTypes: z.number().min(0),
  eventsPerMinute: z.number().min(0),
  avgProcessingTime: z.number().min(0),
  topicCounts: z.instanceof(Map).optional(), // Map is computed client-side
});

export const eventChartDataSchema = z.object({
  throughput: z.array(chartDataPointSchema),
  lag: z.array(chartDataPointSchema),
});

// ===========================
// Platform Health Schemas
// ===========================

// Service health check result from /api/intelligence/services/health
// See server/service-health.ts for ServiceHealthCheck interface
export const platformServiceSchema = z.object({
  service: z.string(), // Service name (e.g., "PostgreSQL", "Kafka/Redpanda")
  status: z.enum(['up', 'down', 'warning']),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
  details: z.record(z.any()).optional(),
});

// Health endpoint response format from server/intelligence-routes.ts line 3251
export const platformHealthSchema = z.object({
  timestamp: z.string(),
  overallStatus: z.enum(['healthy', 'unhealthy', 'error']),
  services: z.array(platformServiceSchema),
  summary: z
    .object({
      total: z.number(),
      up: z.number(),
      down: z.number(),
      warning: z.number(),
    })
    .optional(),
  error: z.string().optional(), // Present when overallStatus is 'error'
});

export const platformServiceDetailSchema = z.object({
  name: z.string(),
  status: z.string(),
  health: z.string(),
});

export const platformServicesSchema = z.object({
  services: z.array(platformServiceDetailSchema),
});

// ===========================
// Knowledge Graph Schemas
// ===========================

export const graphNodeSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    type: z.string(),
  })
  .passthrough(); // Allow additional properties

export const graphEdgeSchema = z
  .object({
    source: z.string(),
    target: z.string(),
    type: z.string().optional(),
  })
  .passthrough(); // Allow additional properties

export const knowledgeGraphDataSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
});

// ===========================
// API Response Types (inferred from schemas)
// ===========================

export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type RecentAction = z.infer<typeof recentActionSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type ChartDataPoint = z.infer<typeof chartDataPointSchema>;
export type OperationStatus = z.infer<typeof operationStatusSchema>;
export type AgentMetricsApi = z.infer<typeof agentMetricsApiSchema>;
export type Execution = z.infer<typeof executionSchema>;

export type DiscoveredPattern = z.infer<typeof discoveredPatternSchema>;
export type PatternSummary = z.infer<typeof patternSummarySchema>;
export type PatternTrend = z.infer<typeof patternTrendSchema>;
export type QualityTrend = z.infer<typeof qualityTrendSchema>;
export type Pattern = z.infer<typeof patternSchema>;
export type LanguageBreakdown = z.infer<typeof languageBreakdownSchema>;
export type LanguageBreakdownApi = z.infer<typeof languageBreakdownApiSchema>;

export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type ScoringEvidence = z.infer<typeof scoringEvidenceSchema>;
export type SimilarityEvidence = z.infer<typeof similarityEvidenceSchema>;
export type SimilarPatternEntry = z.infer<typeof similarPatternEntrySchema>;
export type PatternSignature = z.infer<typeof patternSignatureSchema>;
export type PatlearnArtifact = z.infer<typeof patlearnArtifactSchema>;
export type PatlearnSummary = z.infer<typeof patlearnSummarySchema>;

export type IntelligenceMetrics = z.infer<typeof intelligenceMetricsSchema>;
export type RecentActivity = z.infer<typeof recentActivitySchema>;
export type AgentPerformance = z.infer<typeof agentPerformanceSchema>;
export type SavingsMetrics = z.infer<typeof savingsMetricsSchema>;

export type CodeAnalysisData = z.infer<typeof codeAnalysisDataSchema>;
export type ComplianceData = z.infer<typeof complianceDataSchema>;
export type PatternSummaryCodeIntel = z.infer<typeof patternSummaryCodeIntelSchema>;

export type Event = z.infer<typeof eventSchema>;
export type EventMetrics = z.infer<typeof eventMetricsSchema>;
export type EventChartData = z.infer<typeof eventChartDataSchema>;

export type PlatformHealth = z.infer<typeof platformHealthSchema>;
export type PlatformServices = z.infer<typeof platformServicesSchema>;

export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type KnowledgeGraphData = z.infer<typeof knowledgeGraphDataSchema>;

// ===========================
// Validation Helpers
// ===========================

/**
 * Safely parse API response with error logging
 * Returns undefined on validation failure
 */
export function safeParseResponse<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  context: string
): T | undefined {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.warn(`[API Validation] ${context}:`, result.error.format());
    return undefined;
  }
  return result.data;
}

/**
 * Parse API response or throw validation error
 * Use when validation failure should prevent further processing
 */
export function parseResponse<T>(schema: z.ZodSchema<T>, data: unknown, context: string): T {
  try {
    return schema.parse(data);
  } catch (error) {
    console.warn(`[API Validation] ${context}:`, error);
    throw new Error(`Invalid API response format for ${context}`);
  }
}

/**
 * Validate array response with partial failure handling
 * Returns valid items and logs invalid ones
 */
export function parseArrayResponse<T>(
  itemSchema: z.ZodSchema<T>,
  data: unknown,
  context: string
): T[] {
  if (!Array.isArray(data)) {
    console.warn(`[API Validation] ${context}: Expected array, got ${typeof data}`);
    return [];
  }

  const validItems: T[] = [];
  data.forEach((item, index) => {
    const result = itemSchema.safeParse(item);
    if (result.success) {
      validItems.push(result.data);
    } else {
      console.warn(`[API Validation] ${context}[${index}]:`, result.error.format());
    }
  });

  return validItems;
}
