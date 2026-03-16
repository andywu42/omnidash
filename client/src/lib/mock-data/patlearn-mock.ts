/**
 * PATLEARN Mock Data Generator
 *
 * Generates realistic mock data for the Pattern Learning dashboard
 * when the database is unavailable. Used for graceful degradation.
 *
 * Part of OMN-1798: Pattern Health Visualization
 */

import type {
  PatlearnArtifact,
  PatlearnSummary,
  LifecycleState,
} from '../schemas/api-response-schemas';

// ===========================
// Mock Pattern Definitions
// ===========================

const MOCK_PATTERNS = [
  { name: 'Circuit Breaker', type: 'resilience', language: 'TypeScript' },
  { name: 'Repository Gateway', type: 'data-access', language: 'TypeScript' },
  { name: 'Event Sourcing Handler', type: 'event-driven', language: 'Python' },
  { name: 'ONEX Effect Pattern', type: 'behavioral', language: 'Python' },
  { name: 'Retry with Backoff', type: 'resilience', language: 'TypeScript' },
  { name: 'Message Queue Consumer', type: 'messaging', language: 'Python' },
  { name: 'API Rate Limiter', type: 'security', language: 'Go' },
  { name: 'Cache-Aside Pattern', type: 'caching', language: 'TypeScript' },
  { name: 'Saga Orchestrator', type: 'transaction', language: 'Java' },
  { name: 'Domain Event Publisher', type: 'event-driven', language: 'TypeScript' },
  { name: 'Async Task Queue', type: 'concurrency', language: 'Python' },
  { name: 'GraphQL Resolver', type: 'api', language: 'TypeScript' },
  { name: 'WebSocket Manager', type: 'realtime', language: 'TypeScript' },
  { name: 'File Upload Handler', type: 'io', language: 'Python' },
  { name: 'State Machine', type: 'behavioral', language: 'TypeScript' },
  { name: 'Plugin Loader', type: 'extensibility', language: 'TypeScript' },
  { name: 'Callback Hell Handler', type: 'async', language: 'JavaScript' },
  { name: 'Async Data Stream', type: 'streaming', language: 'Python' },
  { name: 'Service Locator', type: 'di', language: 'Java' },
  { name: 'Observer Pattern', type: 'behavioral', language: 'TypeScript' },
  { name: 'Command Handler', type: 'cqrs', language: 'TypeScript' },
  { name: 'Query Builder', type: 'data-access', language: 'Python' },
  { name: 'Middleware Chain', type: 'pipeline', language: 'TypeScript' },
  { name: 'Error Boundary', type: 'error-handling', language: 'TypeScript' },
  { name: 'Lazy Loader', type: 'performance', language: 'TypeScript' },
] as const;

const LIFECYCLE_STATES: LifecycleState[] = ['candidate', 'provisional', 'validated', 'deprecated'];

// ===========================
// Utility Functions
// ===========================

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number, decimals = 2): number {
  const value = Math.random() * (max - min) + min;
  return parseFloat(value.toFixed(decimals));
}

function randomItem<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function pastDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
}

// ===========================
// Mock Data Generators
// ===========================

/**
 * Generate a single mock PATLEARN artifact
 */
function generateMockArtifact(
  index: number,
  overrides: Partial<{ lifecycleState: LifecycleState; score: number }> = {}
): PatlearnArtifact {
  const pattern = MOCK_PATTERNS[index % MOCK_PATTERNS.length];
  const lifecycleState = overrides.lifecycleState ?? randomItem(LIFECYCLE_STATES);
  const baseScore = overrides.score ?? randomFloat(0.55, 0.98);

  // Adjust score based on lifecycle state for realism
  const score =
    lifecycleState === 'validated'
      ? Math.max(0.75, baseScore)
      : lifecycleState === 'deprecated'
        ? Math.min(0.6, baseScore)
        : baseScore;

  const daysAgo = randomInt(1, 30);

  return {
    id: generateUUID(),
    patternId: generateUUID(),
    patternName: pattern.name,
    patternType: pattern.type,
    language: pattern.language,
    lifecycleState,
    stateChangedAt: pastDate(randomInt(1, 14)),
    compositeScore: score,
    scoringEvidence: {
      labelAgreement: {
        score: randomFloat(0.7, 1.0),
        matchedLabels: [pattern.type, 'design-pattern'],
        totalLabels: randomInt(3, 6),
        disagreements: [],
      },
      clusterCohesion: {
        score: randomFloat(0.65, 0.98),
        clusterId: `cluster-${generateUUID().slice(0, 8)}`,
        memberCount: randomInt(10, 50),
        avgPairwiseSimilarity: randomFloat(0.6, 0.9),
        medoidId: `medoid-${generateUUID().slice(0, 8)}`,
      },
      frequencyFactor: {
        score: randomFloat(0.5, 1.0),
        observedCount: randomInt(5, 100),
        minRequired: 5,
        windowDays: 30,
      },
    },
    signature: {
      hash: `sha256-${generateUUID().replace(/-/g, '')}`,
      version: '1.0.0',
      algorithm: 'sha256',
      inputs: ['ast', 'keywords', 'structure'],
    },
    metrics: {
      processingTimeMs: randomInt(50, 500),
      inputCount: randomInt(10, 100),
      clusterCount: randomInt(3, 15),
      dedupMergeCount: randomInt(0, 10),
      scoreHistory: Array.from({ length: 5 }, (_, i) => ({
        score: randomFloat(score - 0.1, score + 0.05),
        timestamp: pastDate(daysAgo - i * 2),
      })),
    },
    metadata: {
      description: `Implementation of the ${pattern.name} pattern for ${pattern.type} scenarios`,
      __demo: true,
      __demoCreatedAt: new Date().toISOString(),
    },
    createdAt: pastDate(daysAgo),
    updatedAt: pastDate(randomInt(0, daysAgo)),
  };
}

/**
 * Generate a list of mock PATLEARN artifacts
 */
export function generateMockPatterns(count = 25): PatlearnArtifact[] {
  // Distribute across lifecycle states for realistic distribution
  const stateDistribution: { state: LifecycleState; count: number }[] = [
    { state: 'candidate', count: Math.floor(count * 0.32) }, // ~32%
    { state: 'provisional', count: Math.floor(count * 0.24) }, // ~24%
    { state: 'validated', count: Math.floor(count * 0.24) }, // ~24%
    { state: 'deprecated', count: Math.floor(count * 0.2) }, // ~20%
  ];

  const patterns: PatlearnArtifact[] = [];
  let index = 0;

  for (const { state, count: stateCount } of stateDistribution) {
    for (let i = 0; i < stateCount; i++) {
      patterns.push(generateMockArtifact(index++, { lifecycleState: state }));
    }
  }

  // Fill remaining to reach exact count
  while (patterns.length < count) {
    patterns.push(generateMockArtifact(index++));
  }

  // Sort by composite score descending (like the real API)
  return patterns.sort((a, b) => b.compositeScore - a.compositeScore);
}

/**
 * Generate mock PATLEARN summary
 */
export function generateMockSummary(window: '24h' | '7d' | '30d' = '24h'): PatlearnSummary {
  const byState = {
    requested: randomInt(0, 3),
    candidate: randomInt(6, 10),
    provisional: randomInt(4, 8),
    validated: randomInt(4, 8),
    deprecated: randomInt(3, 6),
  };

  const totalPatterns = Object.values(byState).reduce((a, b) => a + b, 0);

  return {
    totalPatterns,
    byState,
    avgScores: {
      labelAgreement: randomFloat(0.75, 0.92),
      clusterCohesion: randomFloat(0.68, 0.88),
      frequencyFactor: randomFloat(0.6, 0.85),
      composite: randomFloat(0.7, 0.88),
    },
    window,
    promotionsInWindow: window === '24h' ? randomInt(0, 2) : randomInt(1, 5),
    deprecationsInWindow: window === '24h' ? randomInt(0, 1) : randomInt(0, 3),
  };
}

// ===========================
// Singleton Cache
// ===========================

// Cache mock data per session to maintain consistency
// Keyed by parameters to ensure cache invalidation on param changes
let cachedPatterns: { count: number; data: PatlearnArtifact[] } | null = null;
let cachedSummary: { window: string; data: PatlearnSummary } | null = null;

/**
 * Get cached mock patterns (generates once per session per count)
 */
export function getMockPatterns(count = 25): PatlearnArtifact[] {
  if (!cachedPatterns || cachedPatterns.count !== count) {
    cachedPatterns = { count, data: generateMockPatterns(count) };
  }
  return cachedPatterns.data;
}

/**
 * Get cached mock summary (generates once per session per window)
 */
export function getMockSummary(window: '24h' | '7d' | '30d' = '24h'): PatlearnSummary {
  if (!cachedSummary || cachedSummary.window !== window) {
    cachedSummary = { window, data: generateMockSummary(window) };
  }
  return cachedSummary.data;
}

/**
 * Clear cached mock data (useful for testing)
 */
export function clearMockCache(): void {
  cachedPatterns = null;
  cachedSummary = null;
}
