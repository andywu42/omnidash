import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock heavy dependencies before importing the module under test
vi.mock('../projection-bootstrap', () => {
  const mockGetView = vi.fn();
  return {
    projectionService: {
      getView: mockGetView,
    },
    enforcementProjection: {
      probeRecentCount: vi.fn().mockResolvedValue(5),
    },
  };
});

vi.mock('../storage', () => ({
  tryGetIntelligenceDb: vi.fn().mockReturnValue(null),
}));

vi.mock('../event-bus-data-source', () => ({
  getEventBusDataSource: vi.fn().mockReturnValue(null),
}));

vi.mock('../read-model-consumer', () => ({
  readModelConsumer: {
    getStats: vi.fn().mockReturnValue({
      isRunning: false,
      topicStats: {},
    }),
  },
  READ_MODEL_TOPICS: ['topic-a', 'topic-b'],
}));

vi.mock('../event-bus-health-poller', () => ({
  EXPECTED_TOPICS: ['topic-a', 'topic-b'],
}));

vi.mock('../../shared/topics', () => ({
  TOPIC_OMNICLAUDE_AGENT_ACTIONS: 'onex.evt.omniclaude.agent-actions.v1',
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS: 'onex.evt.omniclaude.routing-decisions.v1',
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION: 'onex.evt.omniclaude.agent-transformation.v1',
}));

import { runStartupSelfTest, getLatestSelfTestReport } from '../startup-self-test';
import { projectionService } from '../projection-bootstrap';

describe('startup-self-test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces exactly 14 entries', async () => {
    // All projections return null (no views registered)
    (projectionService.getView as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const report = await runStartupSelfTest();

    expect(report.entries).toHaveLength(14);
    expect(report.summary.live + report.summary.empty + report.summary.error).toBe(14);
    expect(report.ranAt).toBeTruthy();
  });

  it('caches the latest report', async () => {
    (projectionService.getView as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const report = await runStartupSelfTest();
    const cached = getLatestSelfTestReport();

    expect(cached).toBe(report);
  });

  it('marks sources as LIVE when projections have data', async () => {
    (projectionService.getView as ReturnType<typeof vi.fn>).mockImplementation((viewId: string) => {
      if (viewId === 'event-bus') {
        return {
          getSnapshot: () => ({
            payload: { totalEventsIngested: 42 },
            snapshotTimeMs: Date.now(),
          }),
        };
      }
      if (viewId === 'intent-db') {
        return {
          getSnapshot: () => ({
            payload: { totalIntents: 10, lastEventTimeMs: Date.now() },
          }),
        };
      }
      return undefined;
    });

    const report = await runStartupSelfTest();

    const eventBus = report.entries.find((e) => e.source === 'eventBus');
    expect(eventBus?.status).toBe('LIVE');
    expect(eventBus?.detail).toContain('42');

    const intents = report.entries.find((e) => e.source === 'intents');
    expect(intents?.status).toBe('LIVE');
  });

  it('marks sources as EMPTY with hints when projections have no data', async () => {
    (projectionService.getView as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const report = await runStartupSelfTest();

    const baselines = report.entries.find((e) => e.source === 'baselines');
    expect(baselines?.status).toBe('EMPTY');
    expect(baselines?.hint).toContain('DATA_SOURCE_DEPENDENCIES.md');
  });

  it('all 14 source names are unique', async () => {
    (projectionService.getView as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const report = await runStartupSelfTest();
    const names = report.entries.map((e) => e.source);
    expect(new Set(names).size).toBe(14);
  });

  it('contains the expected 14 data source names', async () => {
    (projectionService.getView as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const report = await runStartupSelfTest();
    const names = new Set(report.entries.map((e) => e.source));

    const expected = [
      'eventBus',
      'effectiveness',
      'extraction',
      'baselines',
      'costTrends',
      'intents',
      'nodeRegistry',
      'correlationTrace',
      'validation',
      'patterns',
      'topicParity',
      'insights',
      'executionGraph',
      'enforcement',
    ];

    for (const name of expected) {
      expect(names.has(name)).toBe(true);
    }
  });
});
