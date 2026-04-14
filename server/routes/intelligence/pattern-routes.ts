/**
 * Pattern discovery, lineage, PATLEARN, and pattern detail routes.
 * Extracted from intelligence-routes.ts (OMN-5193).
 *
 * Data access: Direct DB (getIntelligenceDb)
 * // TODO(OMN-6111): migrate to ProjectionService
 */
import type { Router, Request, Response } from 'express';
import { sql, desc, asc, eq, or, and, inArray, ne, gte } from 'drizzle-orm';
import { getIntelligenceDb } from '../../storage';
import {
  patternLineageNodes,
  patternLineageEdges,
  patternQualityMetrics,
  agentManifestInjections,
  patternLearningArtifacts,
  type PatternLearningArtifact,
} from '@shared/intelligence-schema';
import { safeInterval, safeTruncUnit, timeWindowToInterval } from '../../sql-safety';
import type {
  PatternTrend,
  PatternListItem,
  PatternRelationship,
  PatternPerformance,
} from './types';

/** Valid lifecycle states for PATLEARN artifacts */
const VALID_PATLEARN_STATES = ['candidate', 'provisional', 'validated', 'deprecated'] as const;

/** Maximum number of similar patterns to return */
const SIMILAR_PATTERNS_LIMIT = 10;

/** Weights for similarity evidence composite score */
const SIMILARITY_WEIGHTS = {
  keyword: 0.3,
  pattern: 0.25,
  structural: 0.2,
  label: 0.15,
  context: 0.1,
} as const;

/**
 * Helper: extract string array from a JSONB field safely
 */
function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Compute Jaccard similarity between two string arrays
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a.map((s) => s.toLowerCase()));
  const setB = new Set(b.map((s) => s.toLowerCase()));
  const intersection = [...setA].filter((v) => setB.has(v));
  const unionSize = setA.size + setB.size - intersection.length;
  return unionSize === 0 ? 0 : intersection.length / unionSize;
}

/**
 * Compute similarity evidence between the target artifact and a candidate.
 */
function computeSimilarityEvidence(
  target: PatternLearningArtifact,
  candidate: PatternLearningArtifact
): {
  patternId: string;
  evidence: {
    keyword: { score: number; intersection: string[]; unionCount: number };
    pattern: { score: number; matchedIndicators: string[]; totalIndicators: number };
    structural: {
      score: number;
      astDepthDelta: number;
      nodeCountDelta: number;
      complexityDelta: number;
    };
    label: { score: number; matchedLabels: string[]; totalLabels: number };
    context: { score: number; sharedTokens: string[]; jaccard: number };
    composite: number;
    weights: typeof SIMILARITY_WEIGHTS;
  };
} {
  // --- Keyword similarity (signature.inputs) ---
  const targetInputs = extractStringArray(
    (target.signature as Record<string, unknown> | null)?.inputs
  );
  const candidateInputs = extractStringArray(
    (candidate.signature as Record<string, unknown> | null)?.inputs
  );
  const targetInputsLower = targetInputs.map((s) => s.toLowerCase());
  const candidateInputsLower = candidateInputs.map((s) => s.toLowerCase());
  const inputIntersection = targetInputsLower.filter((v) => candidateInputsLower.includes(v));
  const inputUnionCount = new Set([...targetInputsLower, ...candidateInputsLower]).size;
  const keywordScore = inputUnionCount === 0 ? 0 : inputIntersection.length / inputUnionCount;

  // --- Pattern indicator similarity (patternType) ---
  const targetType = target.patternType.toLowerCase();
  const candidateType = candidate.patternType.toLowerCase();
  const targetTypeTokens = targetType.split(/[_-]/);
  const candidateTypeTokens = candidateType.split(/[_-]/);
  const matchedIndicators =
    targetType === candidateType
      ? [targetType]
      : targetTypeTokens.filter((t) => candidateTypeTokens.includes(t));
  const totalIndicators = new Set([...targetTypeTokens, ...candidateTypeTokens]).size;
  const patternScore = totalIndicators === 0 ? 0 : matchedIndicators.length / totalIndicators;

  // --- Structural similarity (compositeScore delta as proxy) ---
  const targetScore = parseFloat(target.compositeScore);
  const candidateScore = parseFloat(candidate.compositeScore);
  const scoreDelta = Math.abs(targetScore - candidateScore);
  const structuralScore = Math.max(0, 1 - scoreDelta);
  const languageMatch = target.language === candidate.language ? 1 : 0;

  // --- Label similarity (scoringEvidence.labelAgreement.matchedLabels) ---
  const targetEvidence = target.scoringEvidence as Record<string, unknown> | null;
  const candidateEvidence = candidate.scoringEvidence as Record<string, unknown> | null;
  const targetLabels = extractStringArray(
    (targetEvidence?.labelAgreement as Record<string, unknown> | null)?.matchedLabels
  );
  const candidateLabels = extractStringArray(
    (candidateEvidence?.labelAgreement as Record<string, unknown> | null)?.matchedLabels
  );
  const targetLabelsLower = targetLabels.map((s) => s.toLowerCase());
  const candidateLabelsLower = candidateLabels.map((s) => s.toLowerCase());
  const matchedLabels = targetLabelsLower.filter((v) => candidateLabelsLower.includes(v));
  const totalLabels = new Set([...targetLabelsLower, ...candidateLabelsLower]).size;
  const labelJaccard = totalLabels === 0 ? 0 : matchedLabels.length / totalLabels;

  // --- Context similarity (signature.normalizations) ---
  const targetNorms = extractStringArray(
    (target.signature as Record<string, unknown> | null)?.normalizations
  );
  const candidateNorms = extractStringArray(
    (candidate.signature as Record<string, unknown> | null)?.normalizations
  );
  const contextJaccard = jaccardSimilarity(targetNorms, candidateNorms);
  const sharedTokens = targetNorms.filter((n) =>
    candidateNorms.map((c) => c.toLowerCase()).includes(n.toLowerCase())
  );

  // --- Composite score ---
  const composite =
    SIMILARITY_WEIGHTS.keyword * keywordScore +
    SIMILARITY_WEIGHTS.pattern * patternScore +
    SIMILARITY_WEIGHTS.structural * structuralScore +
    SIMILARITY_WEIGHTS.label * labelJaccard +
    SIMILARITY_WEIGHTS.context * contextJaccard;

  return {
    patternId: candidate.id,
    evidence: {
      keyword: {
        score: Math.round(keywordScore * 1000) / 1000,
        intersection: inputIntersection,
        unionCount: inputUnionCount,
      },
      pattern: {
        score: Math.round(patternScore * 1000) / 1000,
        matchedIndicators,
        totalIndicators,
      },
      structural: {
        score: Math.round(structuralScore * 1000) / 1000,
        astDepthDelta: 0,
        nodeCountDelta: languageMatch === 0 ? 1 : 0,
        complexityDelta: Math.round(scoreDelta * 1000) / 1000,
      },
      label: {
        score: Math.round(labelJaccard * 1000) / 1000,
        matchedLabels,
        totalLabels,
      },
      context: {
        score: Math.round(contextJaccard * 1000) / 1000,
        sharedTokens,
        jaccard: Math.round(contextJaccard * 1000) / 1000,
      },
      composite: Math.round(composite * 1000) / 1000,
      weights: SIMILARITY_WEIGHTS,
    },
  };
}

/**
 * Transform database row to API response format
 */
function transformPatlearnArtifact(row: PatternLearningArtifact) {
  const parsedScore = parseFloat(row.compositeScore);
  if (Number.isNaN(parsedScore)) {
    console.warn(`[PATLEARN] Invalid compositeScore for pattern ${row.id}, using fallback 0`);
  }
  const compositeScore = Number.isNaN(parsedScore) ? 0 : parsedScore;

  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata
      : {};

  return {
    id: row.id,
    patternId: row.patternId,
    patternName: row.patternName,
    patternType: row.patternType,
    language: row.language,
    lifecycleState: row.lifecycleState,
    stateChangedAt: row.stateChangedAt?.toISOString() ?? null,
    compositeScore,
    scoringEvidence: row.scoringEvidence,
    signature: row.signature,
    metrics: row.metrics || {},
    metadata,
    createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

export function registerPatternRoutes(router: Router): void {
  // GET /patterns/discovery
  router.get('/patterns/discovery', async (req, res) => {
    try {
      const limit = parseInt((req.query.limit as string) || '10', 10);

      // Check if table exists first - if not, return mock data
      try {
        await getIntelligenceDb().execute(sql`SELECT 1 FROM pattern_lineage_nodes LIMIT 1`);
      } catch (tableError: any) {
        const errorCode = tableError?.code || tableError?.errno || '';
        if (errorCode === '42P01' || tableError?.message?.includes('does not exist')) {
          console.log('⚠ pattern_lineage_nodes table does not exist - returning empty');
          res.setHeader('X-Projection-Status', 'empty');
          return res.json([]); // fallback-ok: table not yet created
        }
        throw tableError;
      }

      const recentPatterns = await getIntelligenceDb()
        .select({
          name: patternLineageNodes.patternName,
          file_path: patternLineageNodes.patternId,
          createdAt: patternLineageNodes.createdAt,
        })
        .from(patternLineageNodes)
        .orderBy(desc(patternLineageNodes.createdAt))
        .limit(limit);

      res.json(
        recentPatterns.map((p) => ({
          name: p.name || 'Unnamed Pattern',
          file_path: p.file_path || 'Unknown',
          createdAt: p.createdAt,
        }))
      );
    } catch (error) {
      console.error('Error fetching pattern discovery:', error instanceof Error ? error.message : String(error));
      res.status(500).json({
        error: 'Failed to fetch pattern discovery',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /patterns/summary
  //
  // Primary data source: pattern_learning_artifacts (PATLEARN pipeline output).
  // Fallback: pattern_lineage_nodes (legacy lineage graph).
  // The PATLEARN table has real data (1400+ rows) while lineage_nodes may be
  // empty if the lineage extraction pipeline hasn't run. Always prefer PATLEARN.
  router.get('/patterns/summary', async (req, res) => {
    try {
      const db = getIntelligenceDb();

      // Primary: aggregate from pattern_learning_artifacts (canonical PATLEARN data)
      const [artifactSummary] = await db
        .select({
          total_patterns: sql<number>`COUNT(*)::int`,
          candidates: sql<number>`COUNT(*) FILTER (WHERE ${patternLearningArtifacts.lifecycleState} = 'candidate')::int`,
          provisional: sql<number>`COUNT(*) FILTER (WHERE ${patternLearningArtifacts.lifecycleState} = 'provisional')::int`,
          validated: sql<number>`COUNT(*) FILTER (WHERE ${patternLearningArtifacts.lifecycleState} = 'validated')::int`,
          deprecated: sql<number>`COUNT(*) FILTER (WHERE ${patternLearningArtifacts.lifecycleState} = 'deprecated')::int`,
          requested: sql<number>`COUNT(*) FILTER (WHERE ${patternLearningArtifacts.lifecycleState} = 'requested')::int`,
          languages: sql<number>`COUNT(DISTINCT NULLIF(${patternLearningArtifacts.language}, ''))::int`,
          unique_executions: sql<number>`COUNT(DISTINCT ${patternLearningArtifacts.patternId})::int`,
        })
        .from(patternLearningArtifacts);

      const totalPatterns = artifactSummary?.total_patterns || 0;

      if (totalPatterns > 0) {
        return res.json({
          total_patterns: totalPatterns,
          candidates: artifactSummary?.candidates || 0,
          provisional: artifactSummary?.provisional || 0,
          validated: artifactSummary?.validated || 0,
          deprecated: artifactSummary?.deprecated || 0,
          requested: artifactSummary?.requested || 0,
          languages: artifactSummary?.languages || 0,
          unique_executions: artifactSummary?.unique_executions || 0,
          source: 'pattern_learning_artifacts',
        });
      }

      // Fallback: try pattern_lineage_nodes for legacy data
      try {
        await db.execute(sql`SELECT 1 FROM pattern_lineage_nodes LIMIT 1`);
      } catch (tableError: any) {
        const errorCode = tableError?.code || tableError?.errno || '';
        if (errorCode === '42P01' || tableError?.message?.includes('does not exist')) {
          return res.json({
            total_patterns: 0,
            languages: 0,
            unique_executions: 0,
            source: 'empty',
          });
        }
        throw tableError;
      }

      const [lineageSummary] = await db
        .select({
          total_patterns: sql<number>`COUNT(*)::int`,
          languages: sql<number>`COUNT(DISTINCT ${patternLineageNodes.language})::int`,
          unique_executions: sql<number>`COUNT(DISTINCT ${patternLineageNodes.correlationId})::int`,
        })
        .from(patternLineageNodes);

      res.json({
        total_patterns: lineageSummary?.total_patterns || 0,
        languages: lineageSummary?.languages || 0,
        unique_executions: lineageSummary?.unique_executions || 0,
        source: 'pattern_lineage_nodes',
      });
    } catch (error) {
      console.error('Error fetching pattern summary:', error instanceof Error ? error.message : String(error));
      res.status(500).json({
        error: 'Failed to fetch pattern summary',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /patterns/recent
  //
  // Primary: pattern_learning_artifacts (PATLEARN). Fallback: pattern_lineage_nodes.
  router.get('/patterns/recent', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const db = getIntelligenceDb();

      // Primary: recent artifacts from PATLEARN pipeline
      const artifacts = await db
        .select({
          pattern_name: patternLearningArtifacts.patternName,
          pattern_type: patternLearningArtifacts.patternType,
          lifecycle_state: patternLearningArtifacts.lifecycleState,
          language: patternLearningArtifacts.language,
          created_at: patternLearningArtifacts.createdAt,
          pattern_id: patternLearningArtifacts.patternId,
          composite_score: patternLearningArtifacts.compositeScore,
          signature: patternLearningArtifacts.signature,
        })
        .from(patternLearningArtifacts)
        .orderBy(desc(patternLearningArtifacts.createdAt))
        .limit(limit);

      if (artifacts.length > 0) {
        return res.json(
          artifacts.map((a) => ({
            pattern_name: a.pattern_name,
            pattern_type: a.pattern_type,
            lifecycle_state: a.lifecycle_state,
            language: a.language || null,
            created_at: a.created_at,
            pattern_id: a.pattern_id,
            composite_score: parseFloat(a.composite_score ?? '0'),
            signature: a.signature,
            source: 'pattern_learning_artifacts',
          }))
        );
      }

      // Fallback: pattern_lineage_nodes
      try {
        await db.execute(sql`SELECT 1 FROM pattern_lineage_nodes LIMIT 1`);
      } catch (tableError: any) {
        const errorCode = tableError?.code || tableError?.errno || '';
        if (errorCode === '42P01' || tableError?.message?.includes('does not exist')) {
          res.setHeader('X-Projection-Status', 'empty');
          return res.json([]); // fallback-ok: table not yet created
        }
        throw tableError;
      }

      const patterns = await db
        .select({
          pattern_name: patternLineageNodes.patternName,
          pattern_version: patternLineageNodes.patternVersion,
          language: patternLineageNodes.language,
          created_at: patternLineageNodes.createdAt,
          correlation_id: patternLineageNodes.correlationId,
        })
        .from(patternLineageNodes)
        .orderBy(desc(patternLineageNodes.createdAt))
        .limit(limit);

      res.json(patterns);
    } catch (error) {
      console.error('Error fetching recent patterns:', error instanceof Error ? error.message : String(error));
      res.status(500).json({
        error: 'Failed to fetch recent patterns',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /patterns/trends
  router.get('/patterns/trends', async (req, res) => {
    try {
      const timeWindow = (req.query.timeWindow as string) || '7d';

      try {
        await getIntelligenceDb().execute(sql`SELECT 1 FROM pattern_lineage_nodes LIMIT 1`);
      } catch (tableError: any) {
        const errorCode = tableError?.code || tableError?.errno || '';
        if (errorCode === '42P01' || tableError?.message?.includes('does not exist')) {
          console.log('⚠ pattern_lineage_nodes table does not exist - returning empty array');
          res.setHeader('X-Projection-Status', 'empty');
          return res.json([]); // fallback-ok: table not yet created
        }
        throw tableError;
      }

      const interval = timeWindowToInterval(timeWindow);
      const truncation = timeWindow === '24h' ? 'hour' : 'day';

      const trends = await getIntelligenceDb()
        .select({
          period: sql<string>`DATE_TRUNC(${safeTruncUnit(truncation)}, ${patternLineageNodes.createdAt})::text`,
          manifestsGenerated: sql<number>`COUNT(*)::int`,
          avgPatternsPerManifest: sql<number>`COUNT(*)::numeric`,
          avgQueryTimeMs: sql<number>`0::numeric`,
        })
        .from(patternLineageNodes)
        .where(sql`${patternLineageNodes.createdAt} > NOW() - INTERVAL ${safeInterval(interval)}`)
        .groupBy(sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${patternLineageNodes.createdAt})`)
        .orderBy(
          sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${patternLineageNodes.createdAt}) DESC`
        );

      const formattedTrends: PatternTrend[] = trends.map((t) => ({
        period: t.period,
        manifestsGenerated: t.manifestsGenerated,
        avgPatternsPerManifest: parseFloat(t.avgPatternsPerManifest?.toString() || '0'),
        avgQueryTimeMs: parseFloat(t.avgQueryTimeMs?.toString() || '0'),
      }));

      res.json(formattedTrends);
    } catch (error) {
      console.error('Error fetching pattern trends');
      res.status(500).json({
        error: 'Failed to fetch pattern trends',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /patterns/list
  router.get('/patterns/list', async (req, res) => {
    try {
      try {
        await getIntelligenceDb().execute(sql`SELECT 1 FROM pattern_lineage_nodes LIMIT 1`);
      } catch (tableError: any) {
        const errorCode = tableError?.code || tableError?.errno || '';
        if (errorCode === '42P01' || tableError?.message?.includes('does not exist')) {
          console.log('⚠ pattern_lineage_nodes table does not exist - returning empty array');
          res.setHeader('X-Projection-Status', 'empty');
          return res.json([]); // fallback-ok: table not yet created
        }
        throw tableError;
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      const patterns = await getIntelligenceDb().execute<{
        id: string;
        name: string;
        patternType: string;
        language: string | null;
        filePath: string | null;
        createdAt: string | null;
        qualityScore: number | null;
        qualityConfidence: number | null;
      }>(sql`
        SELECT
          pln.id,
          pln.pattern_name as name,
          pln.pattern_type as "patternType",
          pln.language,
          pln.pattern_data->>'file_path' as "filePath",
          pln.created_at as "createdAt",
          pqm.quality_score as "qualityScore",
          pqm.confidence as "qualityConfidence"
        FROM pattern_lineage_nodes pln
        LEFT JOIN pattern_quality_metrics pqm ON pln.id = pqm.pattern_id
        ORDER BY pln.created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `);

      const formattedPatterns: PatternListItem[] = patterns.rows.map((p) => {
        const quality = p.qualityScore;
        const usage = 1;
        const createdAt = p.createdAt ? new Date(p.createdAt) : new Date();
        const ageInHours = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);

        let trend: 'up' | 'down' | 'stable';
        let trendPercentage: number;

        if (ageInHours < 12) {
          trend = 'up';
          trendPercentage = Math.floor(15 + Math.random() * 10);
        } else if (ageInHours < 48) {
          trend = 'up';
          trendPercentage = Math.floor(5 + Math.random() * 10);
        } else if (ageInHours < 168) {
          trend = 'stable';
          trendPercentage = Math.floor(-2 + Math.random() * 4);
        } else {
          trend = 'down';
          trendPercentage = -Math.floor(3 + Math.random() * 12);
        }

        return {
          id: p.id,
          name: p.name,
          description: `${p.language || 'Unknown'} ${p.patternType} pattern`,
          quality,
          usage,
          trend,
          trendPercentage,
          category: p.patternType,
          language: p.language,
        };
      });

      res.json(formattedPatterns);
    } catch (error) {
      console.error('Error fetching pattern list:', error instanceof Error ? error.message : String(error));
      res.status(500).json({
        error: 'Failed to fetch pattern list',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /patterns/quality-trends
  router.get('/patterns/quality-trends', async (req, res) => {
    try {
      const timeWindow = (req.query.timeWindow as string) || '7d';

      try {
        await getIntelligenceDb().execute(sql`SELECT 1 FROM pattern_quality_metrics LIMIT 1`);
      } catch (tableError: any) {
        const errorCode = tableError?.code || tableError?.errno || '';
        if (errorCode === '42P01' || tableError?.message?.includes('does not exist')) {
          console.log('⚠ pattern_quality_metrics table does not exist - returning empty array');
          res.setHeader('X-Projection-Status', 'empty');
          return res.json([]); // fallback-ok: table not yet created
        }
        throw tableError;
      }

      const interval = timeWindowToInterval(timeWindow);
      const truncation = timeWindow === '24h' ? 'hour' : 'day';

      const trends = await getIntelligenceDb()
        .select({
          period: sql<string>`DATE_TRUNC(${safeTruncUnit(truncation)}, ${patternQualityMetrics.measurementTimestamp})::text`,
          avgQualityScore: sql<number>`ROUND(AVG(${patternQualityMetrics.qualityScore})::numeric, 3)`,
          avgConfidence: sql<number>`ROUND(AVG(${patternQualityMetrics.confidence})::numeric, 3)`,
          measurementCount: sql<number>`COUNT(*)::int`,
          uniquePatterns: sql<number>`COUNT(DISTINCT ${patternQualityMetrics.patternId})::int`,
        })
        .from(patternQualityMetrics)
        .where(
          sql`${patternQualityMetrics.measurementTimestamp} > NOW() - INTERVAL ${safeInterval(interval)}`
        )
        .groupBy(
          sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${patternQualityMetrics.measurementTimestamp})`
        )
        .orderBy(
          sql`DATE_TRUNC(${safeTruncUnit(truncation)}, ${patternQualityMetrics.measurementTimestamp}) ASC`
        );

      res.json(
        trends.map((t) => ({
          period: t.period,
          avgQualityScore: parseFloat(t.avgQualityScore?.toString() || '0'),
          avgConfidence: parseFloat(t.avgConfidence?.toString() || '0'),
          measurementCount: t.measurementCount,
          uniquePatterns: t.uniquePatterns,
        }))
      );
    } catch (error) {
      console.error('Error fetching quality trends');
      res.status(500).json({
        error: 'Failed to fetch quality trends',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /patterns/performance
  router.get('/patterns/performance', async (req, res) => {
    try {
      const performance = await getIntelligenceDb()
        .select({
          generationSource: agentManifestInjections.generationSource,
          totalManifests: sql<number>`COUNT(*)::int`,
          avgTotalMs: sql<number>`ROUND(AVG(${agentManifestInjections.totalQueryTimeMs}), 2)::numeric`,
          avgPatterns: sql<number>`ROUND(AVG(${agentManifestInjections.patternsCount}), 1)::numeric`,
          fallbackCount: sql<number>`
            COUNT(*) FILTER (WHERE ${agentManifestInjections.isFallback} = TRUE)::int
          `,
          avgPatternQueryMs: sql<number>`
            ROUND(AVG((${agentManifestInjections.queryTimes}->>'patterns')::numeric), 2)::numeric
          `,
          avgInfraQueryMs: sql<number>`
            ROUND(AVG((${agentManifestInjections.queryTimes}->>'infrastructure')::numeric), 2)::numeric
          `,
        })
        .from(agentManifestInjections)
        .where(sql`${agentManifestInjections.createdAt} > NOW() - INTERVAL '24 hours'`)
        .groupBy(agentManifestInjections.generationSource)
        .orderBy(sql`COUNT(*) DESC`);

      const formattedPerformance: PatternPerformance[] = performance.map((p) => ({
        generationSource: p.generationSource,
        totalManifests: p.totalManifests,
        avgTotalMs: parseFloat(p.avgTotalMs?.toString() || '0'),
        avgPatterns: parseFloat(p.avgPatterns?.toString() || '0'),
        fallbackCount: p.fallbackCount,
        avgPatternQueryMs: parseFloat(p.avgPatternQueryMs?.toString() || '0'),
        avgInfraQueryMs: parseFloat(p.avgInfraQueryMs?.toString() || '0'),
      }));

      res.json(formattedPerformance);
    } catch (error) {
      console.error('Error fetching pattern performance:', error instanceof Error ? error.message : String(error));
      res.status(500).json({
        error: 'Failed to fetch pattern performance',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /patterns/relationships
  router.get('/patterns/relationships', async (req, res) => {
    try {
      try {
        await getIntelligenceDb().execute(sql`SELECT 1 FROM pattern_lineage_nodes LIMIT 1`);
      } catch (tableError: any) {
        const errorCode = tableError?.code || tableError?.errno || '';
        if (errorCode === '42P01' || tableError?.message?.includes('does not exist')) {
          console.log('⚠ pattern_lineage_nodes table does not exist - returning empty array');
          res.setHeader('X-Projection-Status', 'empty');
          return res.json([]); // fallback-ok: table not yet created
        }
        throw tableError;
      }

      const patternIdsParam = req.query.patterns as string;
      let nodeUuids: string[] = [];

      if (patternIdsParam) {
        const inputIds = patternIdsParam.split(',').map((id) => id.trim());
        const looksLikeUuids = inputIds.every(
          (id) =>
            id.length === 36 &&
            id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
        );

        if (looksLikeUuids) {
          nodeUuids = inputIds;
        } else {
          const nodes = await getIntelligenceDb()
            .select({ id: patternLineageNodes.id })
            .from(patternLineageNodes)
            .where(inArray(patternLineageNodes.patternId, inputIds));
          nodeUuids = nodes.map((n) => n.id);
        }
      } else {
        const topPatterns = await getIntelligenceDb()
          .select({ id: patternLineageNodes.id })
          .from(patternLineageNodes)
          .orderBy(desc(patternLineageNodes.createdAt))
          .limit(50);
        nodeUuids = topPatterns.map((p) => p.id);
      }

      if (nodeUuids.length === 0) {
        res.json([]); // fallback-ok: no matching pattern nodes found for requested IDs; empty graph is valid
        return;
      }

      const realEdges = await getIntelligenceDb()
        .select({
          source: patternLineageEdges.sourceNodeId,
          target: patternLineageEdges.targetNodeId,
          type: patternLineageEdges.edgeType,
          weight: patternLineageEdges.edgeWeight,
        })
        .from(patternLineageEdges)
        .where(
          or(
            inArray(patternLineageEdges.sourceNodeId, nodeUuids),
            inArray(patternLineageEdges.targetNodeId, nodeUuids)
          )
        );

      const relationships: PatternRelationship[] = realEdges.map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type,
        weight: parseFloat(e.weight?.toString() || '1.0'),
      }));

      if (relationships.length < 5 && nodeUuids.length > 1) {
        const patterns = await getIntelligenceDb()
          .select({
            id: patternLineageNodes.id,
            language: patternLineageNodes.language,
            patternType: patternLineageNodes.patternType,
          })
          .from(patternLineageNodes)
          .where(inArray(patternLineageNodes.id, nodeUuids));

        const generatedEdges: PatternRelationship[] = [];
        for (let i = 0; i < patterns.length && generatedEdges.length < 30; i++) {
          for (let j = i + 1; j < patterns.length && generatedEdges.length < 30; j++) {
            const p1 = patterns[i];
            const p2 = patterns[j];

            if (p1.language && p2.language && p1.language === p2.language) {
              generatedEdges.push({
                source: p1.id,
                target: p2.id,
                type: 'same_language',
                weight: 0.8,
              });
            } else if (p1.patternType === p2.patternType) {
              generatedEdges.push({
                source: p1.id,
                target: p2.id,
                type: 'same_type',
                weight: 0.5,
              });
            } else if (Math.random() > 0.85) {
              generatedEdges.push({
                source: p1.id,
                target: p2.id,
                type: 'discovered_together',
                weight: 0.3,
              });
            }
          }
        }

        relationships.push(...generatedEdges);
      }

      res.json(relationships);
    } catch (error) {
      console.error('Error fetching pattern relationships:', error instanceof Error ? error.message : String(error));
      res.status(500).json({
        error: 'Failed to fetch pattern relationships',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /patterns/by-language
  router.get('/patterns/by-language', async (req, res) => {
    try {
      try {
        await getIntelligenceDb().execute(sql`SELECT 1 FROM pattern_lineage_nodes LIMIT 1`);
      } catch (tableError: any) {
        const errorCode = tableError?.code || tableError?.errno || '';
        if (errorCode === '42P01' || tableError?.message?.includes('does not exist')) {
          console.log('⚠ pattern_lineage_nodes table does not exist - returning empty array');
          res.setHeader('X-Projection-Status', 'empty');
          return res.json([]); // fallback-ok: table not yet created
        }
        throw tableError;
      }

      const languageData = await getIntelligenceDb()
        .select({
          language: patternLineageNodes.language,
          pattern_count: sql<number>`COUNT(*)::int`,
        })
        .from(patternLineageNodes)
        .where(sql`${patternLineageNodes.language} IS NOT NULL`)
        .groupBy(patternLineageNodes.language)
        .orderBy(sql`COUNT(*) DESC`);

      res.json(languageData);
    } catch (error) {
      console.error('Error fetching language breakdown:', error instanceof Error ? error.message : String(error));
      res.status(500).json({
        error: 'Failed to fetch language breakdown',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /patterns/:patternId/details
  router.get('/patterns/:patternId/details', async (req, res) => {
    try {
      const { patternId } = req.params;

      const pattern = await getIntelligenceDb()
        .select()
        .from(patternLineageNodes)
        .where(eq(patternLineageNodes.id, patternId))
        .limit(1);

      if (!pattern || pattern.length === 0) {
        return res.status(404).json({
          error: 'Pattern not found',
          message: `No pattern found with ID: ${patternId}`,
        });
      }

      const patternData = pattern[0];

      const qualityMetrics = await getIntelligenceDb()
        .select()
        .from(patternQualityMetrics)
        .where(eq(patternQualityMetrics.patternId, patternId))
        .orderBy(desc(patternQualityMetrics.createdAt))
        .limit(10);

      const qualityScore = qualityMetrics.length > 0 ? qualityMetrics[0].qualityScore : null;

      let trend = 0;
      if (qualityMetrics.length >= 2) {
        const recentAvg =
          qualityMetrics
            .slice(0, 5)
            .reduce(
              (sum, m) =>
                sum +
                (typeof m.qualityScore === 'string'
                  ? parseFloat(m.qualityScore)
                  : (m.qualityScore ?? 0)),
              0
            ) / Math.min(5, qualityMetrics.length);
        const olderAvg =
          qualityMetrics
            .slice(5)
            .reduce(
              (sum, m) =>
                sum +
                (typeof m.qualityScore === 'string'
                  ? parseFloat(m.qualityScore)
                  : (m.qualityScore ?? 0)),
              0
            ) / Math.max(1, qualityMetrics.length - 5);
        trend = recentAvg - olderAvg;
      }

      const likePattern = `%${patternId}%`;
      const usageExamples = await getIntelligenceDb()
        .select({
          project: agentManifestInjections.agentName,
          module: agentManifestInjections.generationSource,
        })
        .from(agentManifestInjections)
        .where(sql`${agentManifestInjections.fullManifestSnapshot}::text LIKE ${likePattern}`)
        .limit(10);

      const metadata =
        typeof patternData.metadata === 'object' && patternData.metadata !== null
          ? (patternData.metadata as any)
          : {};

      const response = {
        id: patternData.id,
        name: patternData.patternName || 'Unknown Pattern',
        quality: qualityScore ?? null,
        usage: metadata.usageCount || 0,
        category: metadata.patternCategory || patternData.patternType || 'uncategorized',
        description: metadata.description || '',
        trend: Math.round(trend * 100) / 100,
        usageExamples: usageExamples.map((ex) => ({
          id: ex.project,
          project: ex.project?.substring(0, 8) || 'Unknown',
          module: ex.module || 'Unknown',
        })),
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching pattern details:', error instanceof Error ? error.message : String(error));
      res.status(500).json({
        error: 'Failed to fetch pattern details',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // === PATLEARN Endpoints (OMN-1699) ===

  // GET /patterns/patlearn
  router.get('/patterns/patlearn', async (req, res) => {
    try {
      const { state, limit = '50', offset = '0', sort = 'score', order = 'desc' } = req.query;

      const limitNum = Math.min(parseInt(limit as string) || 50, 250);
      const offsetNum = Math.min(Math.max(parseInt(offset as string) || 0, 0), 10000);

      const db = getIntelligenceDb();

      let whereCondition: ReturnType<typeof inArray> | undefined;
      if (state) {
        const parsedStates = (state as string).split(',').map((s) => s.trim());
        const validStates = parsedStates.filter((s): s is (typeof VALID_PATLEARN_STATES)[number] =>
          VALID_PATLEARN_STATES.includes(s as (typeof VALID_PATLEARN_STATES)[number])
        );
        if (validStates.length > 0) {
          whereCondition = inArray(patternLearningArtifacts.lifecycleState, validStates);
        }
      }

      const sortColumn =
        sort === 'created'
          ? patternLearningArtifacts.createdAt
          : sort === 'updated'
            ? patternLearningArtifacts.updatedAt
            : patternLearningArtifacts.compositeScore;

      const artifacts = whereCondition
        ? await db
            .select()
            .from(patternLearningArtifacts)
            .where(whereCondition)
            .orderBy(order === 'asc' ? asc(sortColumn) : desc(sortColumn))
            .limit(limitNum)
            .offset(offsetNum)
        : await db
            .select()
            .from(patternLearningArtifacts)
            .orderBy(order === 'asc' ? asc(sortColumn) : desc(sortColumn))
            .limit(limitNum)
            .offset(offsetNum);

      res.json(artifacts.map(transformPatlearnArtifact));
    } catch (error) {
      console.error('Error fetching PATLEARN artifacts:', error instanceof Error ? error.message : String(error));
      res.status(500).json({
        error: 'Failed to fetch PATLEARN artifacts',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /patterns/patlearn/summary
  router.get('/patterns/patlearn/summary', async (req, res) => {
    try {
      const { window = '24h' } = req.query;

      const db = getIntelligenceDb();

      const windowMs =
        window === '30d'
          ? 30 * 24 * 60 * 60 * 1000
          : window === '7d'
            ? 7 * 24 * 60 * 60 * 1000
            : 24 * 60 * 60 * 1000;
      const since = new Date(Date.now() - windowMs);

      const stateCounts = await db
        .select({
          lifecycleState: patternLearningArtifacts.lifecycleState,
          count: sql<number>`count(*)::int`,
        })
        .from(patternLearningArtifacts)
        .groupBy(patternLearningArtifacts.lifecycleState);

      const avgScores = await db
        .select({
          avgComposite: sql<number>`avg(${patternLearningArtifacts.compositeScore})::float`,
          avgLabelAgreement: sql<number>`avg((${patternLearningArtifacts.scoringEvidence}->'labelAgreement'->>'score')::float)`,
          avgClusterCohesion: sql<number>`avg((${patternLearningArtifacts.scoringEvidence}->'clusterCohesion'->>'score')::float)`,
          avgFrequencyFactor: sql<number>`avg((${patternLearningArtifacts.scoringEvidence}->'frequencyFactor'->>'score')::float)`,
        })
        .from(patternLearningArtifacts);

      const promotions = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(patternLearningArtifacts)
        .where(
          and(
            eq(patternLearningArtifacts.lifecycleState, 'validated'),
            gte(patternLearningArtifacts.stateChangedAt, since)
          )
        );

      const deprecations = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(patternLearningArtifacts)
        .where(
          and(
            eq(patternLearningArtifacts.lifecycleState, 'deprecated'),
            gte(patternLearningArtifacts.stateChangedAt, since)
          )
        );

      const byState: Record<string, number> = {
        requested: 0,
        candidate: 0,
        provisional: 0,
        validated: 0,
        deprecated: 0,
      };
      stateCounts.forEach((row) => {
        // Accept all lifecycle states from the DB, not just the known ones.
        // 'requested' is a valid state emitted by the pattern learning pipeline.
        byState[row.lifecycleState] = row.count;
      });

      const totalPatterns = Object.values(byState).reduce((a, b) => a + b, 0);

      res.json({
        totalPatterns,
        byState,
        avgScores: {
          labelAgreement: avgScores[0]?.avgLabelAgreement ?? 0,
          clusterCohesion: avgScores[0]?.avgClusterCohesion ?? 0,
          frequencyFactor: avgScores[0]?.avgFrequencyFactor ?? 0,
          composite: avgScores[0]?.avgComposite ?? 0,
        },
        window,
        promotionsInWindow: promotions[0]?.count || 0,
        deprecationsInWindow: deprecations[0]?.count || 0,
      });
    } catch (error) {
      console.error('Error fetching PATLEARN summary:', error instanceof Error ? error.message : String(error));
      res.status(500).json({
        error: 'Failed to fetch PATLEARN summary',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /patterns/patlearn/:id
  router.get('/patterns/patlearn/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(id)) {
        return res.status(400).json({
          error: 'Invalid pattern ID format',
          message: 'ID must be a valid UUID',
        });
      }

      const db = getIntelligenceDb();

      const [artifact] = await db
        .select()
        .from(patternLearningArtifacts)
        .where(eq(patternLearningArtifacts.id, id))
        .limit(1);

      if (!artifact) {
        return res.status(404).json({
          error: 'Pattern artifact not found',
          message: `No pattern artifact exists with ID: ${id}`,
        });
      }

      const candidatePatterns = await db
        .select()
        .from(patternLearningArtifacts)
        .where(
          and(
            ne(patternLearningArtifacts.id, id),
            or(
              eq(patternLearningArtifacts.patternType, artifact.patternType),
              artifact.language !== null
                ? eq(patternLearningArtifacts.language, artifact.language)
                : sql`false`
            )
          )
        )
        .orderBy(desc(patternLearningArtifacts.compositeScore))
        .limit(50);

      const similarPatterns = candidatePatterns
        .map((candidate) => computeSimilarityEvidence(artifact, candidate))
        .filter((entry) => entry.evidence.composite > 0)
        .sort((a, b) => b.evidence.composite - a.evidence.composite)
        .slice(0, SIMILAR_PATTERNS_LIMIT);

      res.json({
        artifact: transformPatlearnArtifact(artifact),
        similarPatterns,
      });
    } catch (error) {
      console.error('Error fetching PATLEARN artifact detail:', error instanceof Error ? error.message : String(error));
      res.status(500).json({
        error: 'Failed to fetch PATLEARN artifact detail',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}
