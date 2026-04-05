/**
 * Event Bus Monitor Dashboard (OMN-2095)
 *
 * Real-time Kafka event stream visualization for ONEX platform.
 * Uses server-side projection for event aggregation and the
 * useProjectionStream hook for efficient data fetching.
 *
 * Architecture: pure renderer — all buffering, deduplication, sorting,
 * and time-series computation happen server-side in EventBusProjection.
 * The client handles UI concerns: filtering, pausing, search, display.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { DashboardRenderer, type WidgetPropsMap } from '@/lib/widgets';
import {
  eventBusDashboardConfig,
  getEventMonitoringConfig,
  getTopicLabel,
  getTopicMetadata,
  getEventTypeLabel,
  computeNormalizedType,
  getMonitoredTopics,
  topicMatchesSuffix,
  normalizeToSuffix,
  RECENT_EVENTS_WIDGET_ID,
  TOPIC_COLUMN_KEY,
} from '@/lib/configs/event-bus-dashboard';
import { useProjectionStream } from '@/hooks/useProjectionStream';
import type { ProjectionEvent } from '@/hooks/useProjectionStream.types';
import type { EventEnrichment } from '@shared/projection-types';
import {
  fetchEventBusSnapshot,
  type EventBusPayload,
} from '@/lib/data-sources/event-bus-projection-source';
import { TIME_SERIES_BUCKET_MS } from '@shared/event-bus-payload';
import { extractProducerFromTopicOrDefault } from '@shared/topics';
import { extractParsedDetails, type ParsedDetails } from '@/components/event-bus/eventDetailUtils';
import type { DashboardData } from '@/lib/dashboard-schema';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Activity,
  Filter,
  X,
  Pause,
  Play,
  Eye,
  EyeOff,
  AlertTriangle,
  Zap,
  ShieldAlert,
} from 'lucide-react';
import {
  EventDetailPanel,
  type EventDetailPanelProps,
  type FilterRequest,
} from '@/components/event-bus/EventDetailPanel';
import { TopicSelector } from '@/components/event-bus/TopicSelector';

// ============================================================================
// Types
// ============================================================================

interface FilterState {
  topic: string | null;
  priority: string | null;
  search: string;
}

/** Display-oriented event derived from ProjectionEvent */
interface DisplayEvent {
  id: string;
  topic: string;
  topicRaw: string;
  eventType: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
  timestamp: Date;
  timestampRaw: string;
  source: string;
  correlationId?: string;
  payload: string;
  summary: string;
  normalizedType: string;
  parsedDetails: ParsedDetails | null;
}

interface PausedSnapshot {
  events: DisplayEvent[];
  topicBreakdown: Record<string, number>;
  eventTypeBreakdown: Record<string, number>;
  timeSeries: Array<{ bucketKey: number; count: number }>;
  eventsPerSecond: number;
  errorCount: number;
  activeTopics: number;
  totalEvents: number;
  // Burst/staleness state frozen at pause time (OMN-2158)
  burstInfo: EventBusPayload['burstInfo'];
  burstWindowMs: number;
  monitoringWindowMs: number;
  stalenessThresholdMs: number;
  windowedErrorRate: number;
}

// ============================================================================
// Constants
// ============================================================================

const eventConfig = getEventMonitoringConfig();
const monitoredTopics = getMonitoredTopics();

// Widget ID and topic column key are imported from the config module as
// RECENT_EVENTS_WIDGET_ID and TOPIC_COLUMN_KEY. A rename in the config
// propagates automatically — no local constants to update in sync.

// ============================================================================
// Mapping: ProjectionEvent → DisplayEvent
// ============================================================================

function mapSeverityToPriority(
  severity: ProjectionEvent['severity']
): 'critical' | 'high' | 'normal' | 'low' {
  switch (severity) {
    case 'critical':
      return 'critical';
    case 'error':
      return 'high';
    case 'warning':
      return 'normal';
    case 'info':
      return 'low';
  }
}

/**
 * Build a ParsedDetails object from server-computed EventEnrichment.
 * Used as the fast path in toDisplayEvent() when enrichment is present.
 */
function buildParsedDetailsFromEnrichment(e: EventEnrichment): ParsedDetails {
  return {
    toolName: e.toolName,
    filePath: e.filePath,
    toolInput: e.bashCommand ? { command: e.bashCommand } : undefined,
    nodeId: e.nodeId,
    healthStatus: e.healthStatus,
    selectedAgent: e.selectedAgent,
    confidence: e.confidence,
    actionName: e.actionName ?? e.intentType,
    error: e.error,
    // OMN-3015: propagate enrichment quality fields
    durationMs: e.durationMs,
    promptPreview: e.promptPreview,
  };
}

function toDisplayEvent(event: ProjectionEvent): DisplayEvent {
  const enrichment = event.enrichment;
  const payloadStr = JSON.stringify(event.payload);
  // Fast path: use server-computed enrichment when available.
  // Fallback: client-side extraction for DB-preloaded events without enrichment.
  const parsedDetails = enrichment
    ? buildParsedDetailsFromEnrichment(enrichment)
    : extractParsedDetails(payloadStr, event.type);
  const summary = enrichment?.summary ?? generateSummary(event.type, parsedDetails, event);
  const normalizedType =
    enrichment?.normalizedType ?? computeNormalizedType(event.type, parsedDetails, event.topic);

  // Use a single fallback time so timestamp and timestampRaw are always consistent
  const effectiveTimeMs = event.eventTimeMs > 0 ? event.eventTimeMs : Date.now();
  const timestampRaw = new Date(effectiveTimeMs).toISOString();

  // Resolve source: use event.source if present and not "unknown",
  // otherwise try to extract the producer from the ONEX topic name,
  // falling back to "system" for legacy flat-name topics.
  const resolvedSource =
    event.source && event.source !== 'unknown'
      ? event.source
      : extractProducerFromTopicOrDefault(event.topic);

  return {
    id: event.id,
    topic: getTopicLabel(event.topic),
    topicRaw: event.topic,
    eventType: event.type,
    priority: mapSeverityToPriority(event.severity),
    timestamp: new Date(effectiveTimeMs),
    timestampRaw,
    source: resolvedSource,
    correlationId: event.payload?.correlationId as string | undefined,
    payload: payloadStr,
    summary,
    normalizedType,
    parsedDetails,
  };
}

// computeNormalizedType is imported from @/lib/configs/event-bus-dashboard
// (extracted for testability — see OMN-2196).

// generateSummary is the fallback path for DB-preloaded events without enrichment.
// Remove once all historical events carry server-computed enrichment.
function generateSummary(
  eventType: string,
  details: ParsedDetails | null,
  event: ProjectionEvent
): string {
  if (!details) {
    const actionName = event.payload?.actionType || event.payload?.action_type;
    if (actionName && typeof actionName === 'string') {
      return actionName.length > 60 ? actionName.slice(0, 57) + '...' : actionName;
    }
    return eventType.length > 60 ? eventType.slice(0, 57) + '...' : eventType;
  }

  if (details.toolName) {
    const filePath = details.filePath;
    if (filePath) {
      return `${details.toolName} ${filePath.split('/').pop() || filePath}`;
    }
    return details.toolName;
  }

  if (details.nodeId) {
    return `${details.nodeId} — ${details.healthStatus || details.status || 'healthy'}`;
  }

  if (details.selectedAgent) {
    const conf = details.confidence;
    const confStr = typeof conf === 'number' ? ` (${Math.round(conf * 100)}%)` : '';
    return `Selected ${details.selectedAgent}${confStr}`;
  }

  if (details.error) {
    const errorType = details.actionType || 'Error';
    const msg = details.error.length > 50 ? details.error.slice(0, 47) + '...' : details.error;
    return `${errorType}: ${msg}`;
  }

  if (details.actionName) {
    return details.actionName.length > 60
      ? details.actionName.slice(0, 57) + '...'
      : details.actionName;
  }

  return eventType.length > 60 ? eventType.slice(0, 57) + '...' : eventType;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatEventTime(timestamp: string | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const now = Date.now();
  const diffMs = now - date.getTime();

  // Absolute time portion — always show clock time
  const time = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  // For events older than 24h, prepend the date
  if (diffMs >= 86400000 || diffMs < 0) {
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }

  // Relative suffix for recent events
  let relative: string;
  if (diffMs < 1000) relative = 'just now';
  else if (diffMs < 60000) relative = `${Math.floor(diffMs / 1000)}s ago`;
  else if (diffMs < 3600000) relative = `${Math.floor(diffMs / 60000)}m ago`;
  else relative = `${Math.floor(diffMs / 3600000)}h ago`;

  return `${time} (${relative})`;
}

/** Format a ms duration to a human-readable string (config-driven, never hardcoded). */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60)
    return seconds === Math.floor(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60)
    return minutes === Math.floor(minutes) ? `${minutes} min` : `${minutes.toFixed(1)} min`;
  const hours = minutes / 60;
  return hours === Math.floor(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

function mapPriorityToType(priority: string): 'info' | 'success' | 'warning' | 'error' {
  switch (priority) {
    case 'critical':
      return 'error';
    case 'high':
      return 'warning';
    case 'normal':
      return 'info';
    case 'low':
      return 'success';
    default:
      return 'info';
  }
}

function toLiveEvent(event: DisplayEvent) {
  return {
    id: event.id,
    timestamp: event.timestampRaw,
    type: mapPriorityToType(event.priority),
    severity: mapPriorityToType(event.priority),
    message: `${event.eventType} from ${event.source}`,
    source: event.topicRaw,
    topicRaw: event.topicRaw,
    topic: event.topic,
    priority: event.priority,
    eventType: event.eventType,
  };
}

function toRecentEvent(event: DisplayEvent) {
  return {
    id: event.id,
    // row.topic holds the friendly display label (matches DisplayEvent.topic contract).
    // row.topicRaw holds the raw suffix — this is the value the table reads for the
    // 'topicRaw' column (TOPIC_COLUMN_KEY), which the customCellRenderer intercepts
    // to render the clickable label badge. The renderer never displays the raw value
    // directly; it calls getTopicLabel(raw) to produce the friendly label.
    topic: event.topic,
    topicRaw: event.topicRaw,
    eventType: event.normalizedType,
    summary: event.summary,
    source: event.source,
    timestamp: formatEventTime(event.timestampRaw),
    timestampSort: event.timestampRaw,
    priority: event.priority,
    correlationId: event.correlationId,
    payload: event.payload,
  };
}

// ============================================================================
// Chart Bucketing
// ============================================================================

const OTHER_THRESHOLD_SHARE = 0.03;
const OTHER_THRESHOLD_COUNT = 2;

// Topics excluded from the Event Bus Monitor at display time.
// Exact-match against topicRaw prevents accidental substring collisions.
// tool_call duplicates every tool execution event — it is always noise here because
// the enriched onex.evt.omniclaude.tool-executed.v1 row already appears.
// If tool_call volume becomes significant, move this filter server-side in
// event-bus-data-source.ts to avoid ingestion and unnecessary enrichment work.
const EXCLUDED_TOPICS = ['tool_call'] as const;

function bucketSmallTypes(
  items: Array<{ name: string; eventType: string; eventCount: number }>
): Array<{ name: string; eventType: string; eventCount: number }> {
  const total = items.reduce((sum, i) => sum + i.eventCount, 0);
  if (total === 0) return items;

  const kept: typeof items = [];
  let otherCount = 0;

  for (const item of items) {
    const share = item.eventCount / total;
    if (share < OTHER_THRESHOLD_SHARE || item.eventCount < OTHER_THRESHOLD_COUNT) {
      otherCount += item.eventCount;
    } else {
      kept.push(item);
    }
  }

  if (kept.length === 0) return items;

  if (otherCount > 0) {
    kept.push({ name: 'Other', eventType: 'other', eventCount: otherCount });
  }

  return kept;
}

// ============================================================================
// Component
// ============================================================================

export default function EventBusMonitor() {
  const [maxEvents, setMaxEvents] = useState(eventConfig.max_events);

  const {
    data: snapshot,
    isLoading,
    isConnected: wsConnected,
  } = useProjectionStream<EventBusPayload>('event-bus', fetchEventBusSnapshot, {
    limit: maxEvents,
    refetchInterval: 2000,
  });

  // Map ProjectionEvents to display format (memoized).
  //
  // Proxy-key optimization: keyed on (cursor, totalEventsIngested, events.length)
  // rather than the events array reference, which changes on every poll cycle
  // even when data hasn't changed (JSON.parse creates new arrays).
  //
  // Why these three keys are sufficient:
  //   - cursor (max ingestSeq) increases on every new event ingested
  //   - totalEventsIngested monotonically increases (never resets to same value)
  //   - events.length catches buffer-full edge cases where an evict + insert
  //     could theoretically leave cursor unchanged (belt-and-suspenders)
  //
  // Edge cases:
  //   cursor 0→0: benign — both before/after represent "no events".
  //   undefined→0: React detects this as a dep change (undefined !== 0).
  //   cursor N→reset→N: totalEventsIngested differs (resets to 0 independently).
  //   Sort order change: firstEventId + lastEventId pin both ends of the array,
  //     catching reordering even when aggregate keys match.
  const events = snapshot?.payload?.events;
  const firstEventId = events?.[0]?.id;
  const lastEventId = events && events.length > 0 ? events[events.length - 1]?.id : undefined;
  const displayEvents = useMemo((): DisplayEvent[] => {
    if (!snapshot?.payload?.events) return [];
    const mapped = snapshot.payload.events.map(toDisplayEvent);
    // Client-side dedup: filter out any duplicate IDs (belt-and-suspenders
    // defense in case duplicates slip through the server-side projection)
    const seen = new Set<string>();
    return mapped.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    snapshot?.cursor,
    snapshot?.payload?.totalEventsIngested,
    snapshot?.payload?.events?.length,
    firstEventId,
    lastEventId,
  ]);

  // Extract aggregates from snapshot
  const snapshotPayload = snapshot?.payload;
  const eventsPerSecond = snapshotPayload?.eventsPerSecond ?? 0;
  const errorCount = snapshotPayload?.errorCount ?? 0;
  const activeTopicsCount = snapshotPayload?.activeTopics ?? 0;

  // Connection status: require both snapshot data AND WebSocket connectivity
  // to show "connected". This prevents false "Live Data" when Kafka is down
  // but the snapshot endpoint still returns stale/empty data.
  const isConnected = !isLoading && !!snapshot && wsConnected;

  // UI state
  const [filters, setFilters] = useState<FilterState>({
    topic: null,
    priority: null,
    search: '',
  });
  const [selectedEvent, setSelectedEvent] = useState<EventDetailPanelProps['event']>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [hideHeartbeats, setHideHeartbeats] = useState(true);

  // Paused snapshot
  const pausedSnapshotRef = useRef<PausedSnapshot | null>(null);
  const wasPausedRef = useRef(false);

  // Chart snapshot cache
  const chartSnapshotRef = useRef<{
    eventTypeBreakdownData: Array<{ name: string; eventType: string; eventCount: number }>;
    timeSeriesData: Array<{ time: number; timestamp: string; name: string; events: number }>;
  } | null>(null);

  // Capture snapshot on pause transition
  useEffect(() => {
    if (isPaused && !wasPausedRef.current) {
      pausedSnapshotRef.current = {
        events: displayEvents,
        topicBreakdown: snapshotPayload?.topicBreakdown ?? {},
        eventTypeBreakdown: snapshotPayload?.eventTypeBreakdown ?? {},
        timeSeries: snapshotPayload?.timeSeries ?? [],
        eventsPerSecond,
        errorCount,
        activeTopics: activeTopicsCount,
        totalEvents: displayEvents.length,
        // Freeze burst/staleness state at pause time (OMN-2158)
        burstInfo: snapshotPayload?.burstInfo ?? null,
        burstWindowMs: snapshotPayload?.burstWindowMs ?? 30_000,
        monitoringWindowMs: snapshotPayload?.monitoringWindowMs ?? 5 * 60 * 1000,
        stalenessThresholdMs: snapshotPayload?.stalenessThresholdMs ?? 10 * 60 * 1000,
        windowedErrorRate: snapshotPayload?.windowedErrorRate ?? 0,
      };
      wasPausedRef.current = true;
    } else if (!isPaused && wasPausedRef.current) {
      pausedSnapshotRef.current = null;
      wasPausedRef.current = false;
    }
  }, [isPaused, displayEvents, snapshotPayload, eventsPerSecond, errorCount, activeTopicsCount]);

  // Source data (paused or live)
  const sourceData = useMemo(() => {
    if (isPaused && pausedSnapshotRef.current) {
      return pausedSnapshotRef.current;
    }
    return {
      events: displayEvents,
      topicBreakdown: snapshotPayload?.topicBreakdown ?? {},
      eventTypeBreakdown: snapshotPayload?.eventTypeBreakdown ?? {},
      timeSeries: snapshotPayload?.timeSeries ?? [],
      eventsPerSecond,
      errorCount,
      activeTopics: activeTopicsCount,
      totalEvents: displayEvents.length,
    };
  }, [isPaused, displayEvents, snapshotPayload, eventsPerSecond, errorCount, activeTopicsCount]);

  // Last update time
  const lastUpdate = useMemo(() => {
    if (snapshot?.snapshotTimeMs) {
      return new Date(snapshot.snapshotTimeMs);
    }
    return new Date();
  }, [snapshot?.snapshotTimeMs]);

  // ============================================================================
  // Topic Status Data
  // ============================================================================

  const [statusTick, setStatusTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStatusTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const topicStatusData = useMemo(() => {
    void statusTick;

    const now = Date.now();
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

    // OMN-2193: Merge hardcoded monitored topics with dynamically observed
    // topics from the projection snapshot's topicBreakdown. Observed topics not
    // in the hardcoded list appear dynamically; known topics with no events
    // remain "Silent".
    //
    // Build a normalized suffix -> aggregate count map from topicBreakdown so
    // that env-prefixed variants (dev.onex.cmd...) merge with canonical names.
    const allTopics = new Set<string>(monitoredTopics);
    const topicBreakdown = sourceData.topicBreakdown;
    const normalizedCounts = new Map<string, number>();

    for (const [observedTopic, count] of Object.entries(topicBreakdown)) {
      const normalized = normalizeToSuffix(observedTopic);
      if (!normalized) continue; // skip empty/malformed topic keys
      allTopics.add(normalized);
      normalizedCounts.set(normalized, (normalizedCounts.get(normalized) ?? 0) + count);
    }

    // Build a map from normalized suffix -> newest event timestamp for last-seen
    // display. Pre-compute once instead of O(topics * events) filtering.
    const newestTimestamp = new Map<string, string>();
    for (const event of sourceData.events) {
      const suffix = normalizeToSuffix(event.topicRaw);
      const existing = newestTimestamp.get(suffix);
      if (!existing || event.timestampRaw > existing) {
        newestTimestamp.set(suffix, event.timestampRaw);
      }
    }

    const statusRows = Array.from(allTopics).map((topic) => {
      // Use server-provided aggregate count (authoritative for the buffer).
      const eventCount = normalizedCounts.get(topic) ?? 0;
      const lastEventAt = newestTimestamp.get(topic) ?? null;

      let lastEventFormatted: string;
      if (!lastEventAt) {
        lastEventFormatted = 'never';
      } else {
        const diffMs = now - new Date(lastEventAt).getTime();
        if (diffMs > TWENTY_FOUR_HOURS_MS) {
          lastEventFormatted = '>24h ago';
        } else {
          lastEventFormatted = formatEventTime(lastEventAt);
        }
      }

      let status: 'active' | 'silent' | 'error';
      if (lastEventAt && now - new Date(lastEventAt).getTime() <= FIVE_MINUTES_MS) {
        status = 'active';
      } else {
        status = 'silent';
      }

      return {
        topic,
        label: getTopicLabel(topic),
        category: getTopicMetadata(topic)?.category || 'unknown',
        eventCount,
        lastEventAt,
        lastEventFormatted,
        status,
      };
    });

    statusRows.sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;
      if (b.eventCount !== a.eventCount) return b.eventCount - a.eventCount;
      return a.label.localeCompare(b.label);
    });

    return statusRows;
  }, [sourceData.events, sourceData.topicBreakdown, statusTick]);

  const topicsLoadedCount = useMemo(
    () => topicStatusData.filter((t) => t.eventCount > 0).length,
    [topicStatusData]
  );

  // ============================================================================
  // Filtered Data
  // ============================================================================

  // Whether we're in paused state with a frozen snapshot.
  // Declared here (above filteredData useMemo) to avoid temporal dead zone.
  const paused = isPaused && pausedSnapshotRef.current;

  const filteredData = useMemo((): DashboardData => {
    const { events: srcEvents } = sourceData;

    // Always exclude topics that produce duplicate/noise rows (exact match only).
    const nonExcluded = srcEvents.filter(
      (event) => !EXCLUDED_TOPICS.some((t) => (event.topicRaw ?? '') === t)
    );

    // Apply filters
    const filtered =
      !filters.topic && !filters.priority && !filters.search && !hideHeartbeats
        ? nonExcluded
        : nonExcluded.filter((event) => {
            if (
              hideHeartbeats &&
              (event.topicRaw.includes('heartbeat') ||
                event.eventType.toLowerCase().includes('heartbeat'))
            )
              return false;
            if (filters.topic && !topicMatchesSuffix(event.topicRaw, filters.topic)) return false;
            if (filters.priority && event.priority !== filters.priority) return false;
            if (filters.search) {
              const searchLower = filters.search.toLowerCase();
              // Search both the friendly label (event.topic) and the raw suffix
              // (event.topicRaw) so that typing either form into the search box
              // produces a match. event.topic holds the friendly label (e.g.
              // "Session Started") and event.topicRaw holds the raw suffix (e.g.
              // "onex.evt.omniclaude.session-started.v1") — both are searched.
              const matchesSearch =
                event.eventType.toLowerCase().includes(searchLower) ||
                event.source.toLowerCase().includes(searchLower) ||
                event.topic.toLowerCase().includes(searchLower) ||
                event.topicRaw.toLowerCase().includes(searchLower) ||
                event.summary.toLowerCase().includes(searchLower) ||
                (event.parsedDetails?.toolName?.toLowerCase().includes(searchLower) ?? false) ||
                (event.parsedDetails?.nodeId?.toLowerCase().includes(searchLower) ?? false) ||
                (event.parsedDetails?.selectedAgent?.toLowerCase().includes(searchLower) ??
                  false) ||
                (event.parsedDetails?.actionName?.toLowerCase().includes(searchLower) ?? false);
              if (!matchesSearch) return false;
            }
            return true;
          });

    const displayedEvents = filtered.slice(0, maxEvents);

    // Compute chart data from displayed events
    const topicCounts: Record<string, number> = {};
    const eventTypeCounts: Record<string, number> = {};
    const timeBuckets: Record<number, number> = {};

    for (const event of displayedEvents) {
      topicCounts[event.topicRaw] = (topicCounts[event.topicRaw] || 0) + 1;
      eventTypeCounts[event.normalizedType] = (eventTypeCounts[event.normalizedType] || 0) + 1;
      const bucketTime =
        Math.floor(event.timestamp.getTime() / TIME_SERIES_BUCKET_MS) * TIME_SERIES_BUCKET_MS;
      timeBuckets[bucketTime] = (timeBuckets[bucketTime] || 0) + 1;
    }

    // Fill zero-count gaps so the chart shows flat baseline during idle periods
    // instead of misleading interpolation lines.
    const bucketKeys = Object.keys(timeBuckets).map(Number);
    if (bucketKeys.length > 1) {
      const minBucket = Math.min(...bucketKeys);
      const maxBucket = Math.max(...bucketKeys);
      for (let b = minBucket; b <= maxBucket; b += TIME_SERIES_BUCKET_MS) {
        if (!(b in timeBuckets)) {
          timeBuckets[b] = 0;
        }
      }
    }

    const topicBreakdownData = Object.entries(topicCounts).map(([topic, count]) => ({
      name: getTopicLabel(topic),
      topic,
      eventCount: count,
    }));

    const eventTypeBreakdownRaw = Object.entries(eventTypeCounts).map(([eventType, count]) => ({
      name: getEventTypeLabel(eventType),
      eventType,
      eventCount: count,
    }));
    const eventTypeBreakdownData = bucketSmallTypes(eventTypeBreakdownRaw).sort((a, b) => {
      // "Other" bucket always last (OMN-2308)
      if (a.eventType === 'other') return 1;
      if (b.eventType === 'other') return -1;
      // Descending by count, alphabetical tiebreaker
      if (b.eventCount !== a.eventCount) return b.eventCount - a.eventCount;
      return a.name.localeCompare(b.name);
    });

    const timeSeriesData = Object.entries(timeBuckets)
      .map(([time, count]) => {
        const date = new Date(Number(time));
        const formattedTime = date.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        });
        return {
          time: Number(time),
          timestamp: formattedTime,
          name: formattedTime,
          events: count,
        };
      })
      .sort((a, b) => a.time - b.time);

    // Chart snapshot cache
    if (eventTypeBreakdownData.length > 0) {
      chartSnapshotRef.current = {
        eventTypeBreakdownData,
        timeSeriesData,
      };
    }

    const effectiveBreakdown =
      eventTypeBreakdownData.length > 0
        ? eventTypeBreakdownData
        : (chartSnapshotRef.current?.eventTypeBreakdownData ?? []);
    const effectiveTimeSeries =
      timeSeriesData.length > 0 ? timeSeriesData : (chartSnapshotRef.current?.timeSeriesData ?? []);

    // Error rate: when no filters are active, use server-provided windowedErrorRate
    // (computed within the unified monitoring window — fixes the latent whole-buffer bug).
    // When paused, use the frozen windowedErrorRate. When filters are active, fall back
    // to computing from the filtered set.
    const hasFilters = filters.topic || filters.priority || filters.search || hideHeartbeats;
    const serverErrorRate = paused
      ? pausedSnapshotRef.current!.windowedErrorRate
      : snapshotPayload?.windowedErrorRate;
    const errorRate =
      !hasFilters && serverErrorRate != null
        ? Math.round(serverErrorRate * 10000) / 100
        : displayedEvents.length > 0
          ? Math.round(
              (displayedEvents.filter((e) => e.priority === 'critical' || e.priority === 'high')
                .length /
                displayedEvents.length) *
                10000
            ) / 100
          : 0;

    return {
      totalEvents: displayedEvents.length,
      eventsPerSecond: sourceData.eventsPerSecond,
      errorRate,
      activeTopics: topicsLoadedCount,
      dlqCount: displayedEvents.filter((e) => e.priority === 'critical').length,
      recentEvents: displayedEvents.map(toRecentEvent),
      liveEvents: displayedEvents.map(toLiveEvent),
      topicBreakdownData,
      eventTypeBreakdownData: effectiveBreakdown,
      timeSeriesData: effectiveTimeSeries,
      topicHealth: [],
    };
  }, [
    sourceData,
    filters,
    maxEvents,
    hideHeartbeats,
    topicsLoadedCount,
    paused,
    snapshotPayload?.windowedErrorRate,
  ]);

  // Clear chart snapshot when topic filter changes
  useEffect(() => {
    chartSnapshotRef.current = null;
  }, [filters.topic]);

  // ============================================================================
  // Handlers
  // ============================================================================

  const clearFilters = useCallback(() => {
    setFilters({ topic: null, priority: null, search: '' });
  }, []);

  const handleFilterRequest = useCallback((filter: FilterRequest) => {
    switch (filter.type) {
      case 'topic':
        setFilters((prev) => ({ ...prev, topic: normalizeToSuffix(filter.value) }));
        break;
      case 'source':
        setFilters((prev) => ({ ...prev, search: filter.value }));
        break;
      case 'search':
        setFilters((prev) => ({ ...prev, search: filter.value }));
        break;
    }
  }, []);

  const handleEventClick = useCallback((widgetId: string, row: Record<string, unknown>) => {
    if (widgetId === RECENT_EVENTS_WIDGET_ID) {
      // Contract: rows in the 'table-recent-events' widget are produced exclusively
      // by toRecentEvent(), which stores the raw topic suffix in row.topicRaw and
      // the friendly label in row.topic. Always read rawTopic from row.topicRaw.
      if (import.meta.env.DEV && row.topicRaw === undefined) {
        console.warn(
          '[EventBusMonitor] handleEventClick: row.topicRaw is missing — rawTopic will be empty string. Ensure this row was produced by toRecentEvent().'
        );
      }
      const rawTopic = String(row.topicRaw ?? '');
      setSelectedEvent({
        id: String(row.id || ''),
        topic: getTopicLabel(rawTopic),
        topicRaw: rawTopic,
        eventType: String(row.eventType || ''),
        source: String(row.source || ''),
        // OMN-3015: use timestampSort (ISO string) not timestamp (display string like "2 min ago")
        // so the EventDetailPanel can parse/format the timestamp correctly.
        timestamp: String(row.timestampSort || row.timestamp || ''),
        priority: String(row.priority || 'normal'),
        correlationId: row.correlationId ? String(row.correlationId) : undefined,
        payload: row.payload ? String(row.payload) : undefined,
      });
      setIsPanelOpen(true);
    }
  }, []);

  // ============================================================================
  // Derived State
  // ============================================================================

  const hasActiveFilters = filters.topic || filters.priority || filters.search || hideHeartbeats;

  // Staleness / burst state: respect pause by reading from frozen paused snapshot.
  // When paused, banners stay consistent with the frozen event table/charts.
  // Note: `paused` is defined above (before filteredData useMemo) to avoid TDZ issues.
  const activeBurstInfo = paused
    ? pausedSnapshotRef.current!.burstInfo
    : (snapshotPayload?.burstInfo ?? null);
  const activeBurstWindowMs = paused
    ? pausedSnapshotRef.current!.burstWindowMs
    : (snapshotPayload?.burstWindowMs ?? 30_000);
  const activeMonitoringWindowMs = paused
    ? pausedSnapshotRef.current!.monitoringWindowMs
    : (snapshotPayload?.monitoringWindowMs ?? 5 * 60 * 1000);

  // Staleness detection (uses server-provided threshold from OMN-2158)
  const stalenessThresholdMs = paused
    ? pausedSnapshotRef.current!.stalenessThresholdMs
    : (snapshotPayload?.stalenessThresholdMs ?? 10 * 60 * 1000);
  const stalenessInfo = useMemo(() => {
    const now = Date.now();
    const allEvents = sourceData.events;

    const nonHeartbeatEvents = allEvents.filter(
      (e) => !e.topicRaw.includes('heartbeat') && !e.eventType.toLowerCase().includes('heartbeat')
    );

    const hasOnlyHeartbeats = nonHeartbeatEvents.length === 0 && allEvents.length > 0;
    const hasNoEvents = allEvents.length === 0;

    if (hasNoEvents) return { stale: false, hasOnlyHeartbeats: false } as const;
    if (hasOnlyHeartbeats) return { stale: true, hasOnlyHeartbeats: true } as const;

    const newest = nonHeartbeatEvents.reduce(
      (latest, e) => (e.timestamp.getTime() > latest.timestamp.getTime() ? e : latest),
      nonHeartbeatEvents[0]
    );
    const ageMs = now - newest.timestamp.getTime();

    if (ageMs <= stalenessThresholdMs) return { stale: false, hasOnlyHeartbeats: false } as const;

    let ageStr: string;
    if (ageMs < 3600000) ageStr = `${Math.floor(ageMs / 60000)}m`;
    else if (ageMs < 86400000) ageStr = `${Math.floor(ageMs / 3600000)}h`;
    else ageStr = `${Math.floor(ageMs / 86400000)}d`;

    return {
      stale: true,
      hasOnlyHeartbeats: false,
      ageStr,
      newestTopic: newest.topic,
      newestTimestamp: newest.timestamp.toLocaleString(),
    } as const;
  }, [sourceData.events, stalenessThresholdMs]);

  // ============================================================================
  // Dashboard config splits
  // ============================================================================

  const kpiConfig = useMemo(
    () => ({
      ...eventBusDashboardConfig,
      dashboard_id: 'event-bus-kpis',
      widgets: eventBusDashboardConfig.widgets.filter(
        (w) => w.config.config_kind === 'metric_card'
      ),
    }),
    []
  );

  const chartsConfig = useMemo(
    () => ({
      ...eventBusDashboardConfig,
      dashboard_id: 'event-bus-charts',
      widgets: eventBusDashboardConfig.widgets
        .filter((w) => w.config.config_kind === 'chart')
        .map((w) => ({ ...w, row: w.row - 1 })),
    }),
    []
  );

  const tableConfig = useMemo(
    () => ({
      ...eventBusDashboardConfig,
      dashboard_id: 'event-bus-table',
      widgets: eventBusDashboardConfig.widgets
        .filter((w) => w.config.config_kind === 'table')
        .map((w) => ({ ...w, row: 0 })),
    }),
    []
  );

  /**
   * Custom cell renderer for the Topic column (OMN-2198).
   *
   * Displays the friendly label (from TOPIC_METADATA / suffix extraction) and makes
   * each topic cell clickable — clicking sets the topic filter to the raw suffix,
   * simultaneously highlighting the matching row in the TopicSelector sidebar.
   * stopPropagation prevents the row-click from opening the EventDetailPanel.
   *
   * NOTE: WidgetPropsMap types prop values as `Record<string, unknown>`, so the
   * renderer function type is cast away at the DashboardRenderer boundary in
   * WidgetRenderer.tsx. The actual runtime type is enforced by the
   * `customCellRenderers` shape consumed inside WidgetRenderer. This is existing
   * infrastructure behavior that cannot be fixed in this file alone.
   *
   * Explicitly typed as WidgetPropsMap so that the customCellRenderers shape is
   * captured and the object satisfies the widgetProps prop of DashboardRenderer
   * without relying on structural inference widening the renderer type to unknown.
   *
   * Re-render note: every filters.topic change recreates this renderer object,
   * which causes DashboardRenderer to re-render the table widget (because
   * widgetProps is a new reference). This is acceptable given the WidgetPropsMap
   * infrastructure — the renderer must close over filters.topic to apply the
   * active-filter highlight — but it is worth noting here as the intentional
   * trade-off.
   */
  const tableWidgetProps = useMemo<WidgetPropsMap>(
    () => ({
      [RECENT_EVENTS_WIDGET_ID]: {
        customCellRenderers: {
          // Keyed by TOPIC_COLUMN_KEY ('topicRaw') to stay in sync with the
          // column definition in eventBusDashboardConfig (imported config).
          // The table reads row.topicRaw as the cell value; this renderer
          // intercepts it and displays getTopicLabel(raw) as the friendly label.
          [TOPIC_COLUMN_KEY]: (value: unknown) => {
            const raw = String(value ?? '');
            if (!raw) return null; // no topic value, nothing to render
            const label = getTopicLabel(raw);
            const isActive = filters.topic === raw;
            return (
              <button
                type="button"
                aria-label={`Filter by topic: ${label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setFilters((prev) => ({
                    ...prev,
                    topic: prev.topic === raw ? null : raw,
                  }));
                }}
                className={[
                  'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium transition-colors',
                  'hover:bg-primary/15 hover:text-primary cursor-pointer select-none',
                  isActive
                    ? 'bg-primary/20 text-primary ring-1 ring-primary/40'
                    : 'bg-muted/60 text-foreground',
                ].join(' ')}
                title={raw === label ? undefined : raw}
              >
                {label}
              </button>
            );
          },
        },
      },
    }),
    // setFilters is intentionally omitted: it is a stable React dispatch reference
    // (guaranteed by useState) and never changes between renders.
    [filters.topic]
  );

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-3">
            <Activity className="h-6 w-6 text-primary" />
            {eventBusDashboardConfig.name}
          </h1>
          <p className="text-muted-foreground mt-1">{eventBusDashboardConfig.description}</p>
        </div>

        <div className="flex items-center gap-4">
          {isConnected ? (
            <Badge variant="default" className="bg-green-600 hover:bg-green-700 gap-1">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-100"></span>
              </span>
              Live Data
            </Badge>
          ) : null}

          <div className="text-sm text-muted-foreground">
            Updated: {lastUpdate.toLocaleTimeString()}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsPaused(!isPaused)}
            className="gap-2"
          >
            {isPaused ? (
              <>
                <Play className="h-4 w-4" />
                Resume
              </>
            ) : (
              <>
                <Pause className="h-4 w-4" />
                Pause
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Priority banners: staleness > error spike > throughput burst */}
      {stalenessInfo.stale ? (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-200">
          <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0" />
          <span className="text-sm">
            {stalenessInfo.hasOnlyHeartbeats ? (
              'Only heartbeats detected — no application events in the buffer'
            ) : (
              <>
                No new non-heartbeat events in{' '}
                <span className="font-semibold">{stalenessInfo.ageStr}</span>
                {' — '}producers may not be emitting.
                <span className="text-amber-300/70 ml-2">
                  Newest: {stalenessInfo.newestTimestamp} ({stalenessInfo.newestTopic})
                </span>
              </>
            )}
          </span>
        </div>
      ) : activeBurstInfo?.type === 'error_spike' ? (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-md bg-red-500/10 border border-red-500/30 text-red-200">
          <ShieldAlert className="h-4 w-4 text-red-400 flex-shrink-0" />
          <span className="text-sm">
            Error spike detected — {formatDuration(activeBurstWindowMs)} error rate{' '}
            <span className="font-semibold">
              {(activeBurstInfo.shortWindowRate * 100).toFixed(1)}%
            </span>{' '}
            vs {formatDuration(activeMonitoringWindowMs)} baseline{' '}
            <span className="font-semibold">
              {(activeBurstInfo.baselineRate * 100).toFixed(1)}%
            </span>{' '}
            <span className="text-red-300/70">
              ({activeBurstInfo.multiplier != null ? `${activeBurstInfo.multiplier}x` : 'new'})
            </span>
          </span>
        </div>
      ) : activeBurstInfo?.type === 'throughput' ? (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-md bg-blue-500/10 border border-blue-500/30 text-blue-200">
          <Zap className="h-4 w-4 text-blue-400 flex-shrink-0" />
          <span className="text-sm">
            Throughput burst — {formatDuration(activeBurstWindowMs)} rate{' '}
            <span className="font-semibold">{activeBurstInfo.shortWindowRate} evt/s</span> vs{' '}
            {formatDuration(activeMonitoringWindowMs)} baseline{' '}
            <span className="font-semibold">{activeBurstInfo.baselineRate} evt/s</span>{' '}
            <span className="text-blue-300/70">
              ({activeBurstInfo.multiplier != null ? `${activeBurstInfo.multiplier}x` : 'new'})
            </span>
          </span>
        </div>
      ) : null}

      {/* Filters */}
      <Card className="p-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Filters
            </span>
          </div>

          <Select
            value={filters.priority || 'all'}
            onValueChange={(value) =>
              setFilters((prev) => ({ ...prev, priority: value === 'all' ? null : value }))
            }
          >
            <SelectTrigger className="w-[130px] h-8 text-xs">
              <SelectValue placeholder="All Priorities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Priorities</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex-1 max-w-xs">
            <Input
              placeholder="Search events..."
              value={filters.search}
              onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
              className="h-8 text-xs"
            />
          </div>

          <Button
            variant={hideHeartbeats ? 'default' : 'outline'}
            size="sm"
            onClick={() => setHideHeartbeats(!hideHeartbeats)}
            className="gap-1.5 h-8 text-xs"
          >
            {hideHeartbeats ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            Heartbeats
          </Button>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Max:</span>
            <Select
              value={String(maxEvents)}
              onValueChange={(value) => setMaxEvents(Number(value))}
            >
              <SelectTrigger className="w-[80px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {eventConfig.max_events_options.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {option.toLocaleString()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-1 h-8 text-xs">
              <X className="h-3.5 w-3.5" />
              Clear all
            </Button>
          )}
        </div>
      </Card>

      {/* KPI Metric Cards */}
      <DashboardRenderer config={kpiConfig} data={filteredData} isLoading={isLoading} />

      {/* Topics + Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4 h-[340px]">
        <TopicSelector
          topics={topicStatusData}
          selectedTopic={filters.topic}
          onSelectTopic={(topic) => setFilters((prev) => ({ ...prev, topic: topic }))}
        />

        <DashboardRenderer config={chartsConfig} data={filteredData} isLoading={isLoading} />
      </div>

      {/* Context line + active filter banner */}
      <div className="space-y-2">
        {filters.topic && (
          <div className="flex items-center justify-between px-3 py-2 rounded-md bg-primary/5 border border-primary/20">
            <div className="flex items-center gap-2">
              <div className="h-4 w-1 rounded-full bg-primary" />
              <span className="text-sm font-semibold">{getTopicLabel(filters.topic)}</span>
              <span className="text-[11px] text-muted-foreground font-mono">{filters.topic}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFilters((prev) => ({ ...prev, topic: null }))}
              className="gap-1 h-6 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
              Clear filter
            </Button>
          </div>
        )}

        <div className="text-xs text-muted-foreground px-1">
          Showing last {Number(filteredData.totalEvents ?? 0).toLocaleString()} events, newest first
          {isPaused && <span className="text-amber-500 font-medium"> · paused</span>}
          {hideHeartbeats && <span> · heartbeats hidden</span>}
          {filters.topic && (
            <span>
              {' '}
              · <span className="font-medium">{getTopicLabel(filters.topic)}</span>
            </span>
          )}
          {filters.search && (
            <span>
              {' '}
              · search: "<span className="font-medium">{filters.search}</span>"
            </span>
          )}
        </div>
      </div>

      {/* Event Table */}
      <DashboardRenderer
        config={tableConfig}
        data={filteredData}
        isLoading={isLoading}
        onWidgetRowClick={handleEventClick}
        widgetProps={tableWidgetProps}
      />

      {/* Event Detail Panel */}
      <EventDetailPanel
        event={selectedEvent}
        open={isPanelOpen}
        onOpenChange={setIsPanelOpen}
        onFilterRequest={handleFilterRequest}
      />
    </div>
  );
}
