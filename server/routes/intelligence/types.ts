/**
 * Shared type definitions for intelligence route modules.
 * Extracted from intelligence-routes.ts during OMN-5193 decomposition.
 */
import type { Router } from 'express';

/**
 * Common signature for route registration functions.
 * Each route module exports a function matching this type.
 */
export type RouteRegistrar = (router: Router) => void;

export interface PatternTrend {
  period: string;
  manifestsGenerated: number;
  avgPatternsPerManifest: number;
  avgQueryTimeMs: number;
}

export interface PatternListItem {
  id: string;
  name: string;
  description: string;
  quality: number;
  usage: number;
  trend: 'up' | 'down' | 'stable';
  trendPercentage: number;
  category: string;
  language?: string | null;
}

export interface PatternRelationship {
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface PatternPerformance {
  generationSource: string;
  totalManifests: number;
  avgTotalMs: number;
  avgPatterns: number;
  fallbackCount: number;
  avgPatternQueryMs: number;
  avgInfraQueryMs: number;
}

export interface ManifestInjectionHealth {
  successRate: number;
  avgLatencyMs: number;
  failedInjections: Array<{
    errorType: string;
    count: number;
    lastOccurrence: string;
  }>;
  manifestSizeStats: {
    avgSizeKb: number;
    minSizeKb: number;
    maxSizeKb: number;
  };
  latencyTrend: Array<{
    period: string;
    avgLatencyMs: number;
    count: number;
  }>;
  serviceHealth: {
    postgresql: { status: 'up' | 'down'; latencyMs?: number };
    qdrant: { status: 'up' | 'down'; latencyMs?: number };
  };
}

export interface TransformationSummary {
  totalTransformations: number;
  uniqueSourceAgents: number;
  uniqueTargetAgents: number;
  avgTransformationTimeMs: number;
  successRate: number;
  mostCommonTransformation: {
    source: string;
    target: string;
    count: number;
  } | null;
}

export interface TransformationNode {
  id: string;
  label: string;
}

export interface TransformationLink {
  source: string;
  target: string;
  value: number;
  avgConfidence?: number;
  avgDurationMs?: number;
}

export interface RoutingStrategyBreakdown {
  strategy: string;
  count: number;
  percentage: number;
}
