> **Navigation**: [Home](../INDEX.md) > [Decisions](README.md) > ADR-002

> **Status: SUPERSEDED** -- The `mockOnEmpty` pattern described here was removed in OMN-2331. Dashboards now use API-first data sources with explicit demo mode toggle. Retained for historical context.

# ADR-002: API-First with Mock Fallback for All Data Sources

**Status**: Superseded (OMN-2331)
**Date**: 2026-01
**Deciders**: Omnidash Engineering Team
**Related**: OMN-2304 (extraction dashboard mock fallback), OMN-2298 (global demo mode)

---

## Context

Omnidash dashboards depend on a live infrastructure stack: a PostgreSQL read-model database (`omnidash_analytics`), a Kafka consumer projecting events into it, and Express API routes serving the results. During development or on a machine with no running infrastructure, the database tables are empty or the API is unreachable.

The original approach used pure client-side mock data: dashboard components called mock generators directly and never touched the network. This worked for early UI development but created two problems as dashboards matured:

1. **Silent failures.** When a real API endpoint was introduced, a bug in the endpoint (wrong column name, missing route, malformed JSON) would not surface in the UI. The component fell back to mock data and appeared to work fine.
2. **No infrastructure feedback.** A developer running the dashboard with a live stack had no visual indication of whether they were looking at real data or demo data. Mock and live dashboards looked identical.

A secondary problem emerged with the `mockOnEmpty` pattern from earlier data sources: some sources used a mutable `Set<string>` to track which endpoints had fallen back to mock. This approach was not observable by React — changing a `Set` in-place does not trigger re-renders. The state update was silently dropped.

---

## Decision

All dashboard data sources (`client/src/lib/data-sources/`) adopt an **API-first with mock fallback** pattern with the following rules:

### 1. Always attempt the real API endpoint first

Every fetch method calls the actual Express API route. Mock data is never returned without first attempting the network call (unless `demoMode` is active — see below).

### 2. Return a discriminated union, not raw data

Every fetch method returns `{ data: T; isMock: boolean }` rather than `T` directly. This is a stable, React-observable signal. The `isMock` flag travels with the data through props and query results; components can render a "Demo data" badge without consulting any external state.

```typescript
export interface ExtractionResult<T> {
  data: T;
  isMock: boolean;
}
```

### 3. Primary endpoints use mock fallback on empty

For the primary summary endpoint of each dashboard domain, if the API returns a response that indicates a genuinely empty backing table, mock data is substituted and `isMock: true` is returned. "Empty table" is defined conservatively — typically a combination of a zero-count field and a null sentinel field (e.g., `last_event_at == null`) — to avoid treating a legitimately quiet live deployment as empty.

This is the `mockOnEmpty: true` / `fallbackToMock: true` behaviour. The goal is that a developer who has just set up omnidash with an empty database sees a fully rendered dashboard, not a blank page.

### 4. Secondary endpoints do NOT use mock fallback on empty

Chart endpoints (latency heatmaps, volume time series, error rate breakdowns) treat an empty array as a valid live state: "no data yet in this time window." These endpoints fall back to mock only on a network error or non-200 HTTP status, not on an empty result set. Mixing mock and real data on the same dashboard is intentional — a real summary with empty charts is truthful.

### 5. `demoMode` bypasses the network entirely

When `demoMode: true` is passed to a fetch method, the method returns mock data immediately without making any network request. This is used for demos and screenshots where a fully predictable dataset is required. The flag is independent of `fallbackToMock`.

### 6. JSON parse errors are surfaced at `console.error`, not `console.warn`

A `SyntaxError` from `response.json()` on a 200 response indicates a backend bug (the server returned malformed JSON). This is distinguished from an unreachable API (which uses `console.warn`) so that backend bugs are visible in DevTools without crashing the dashboard.

---

## Consequences

### Positive

- **Always renders.** A developer with no running infrastructure sees a fully populated dashboard with a visible "Demo data" indicator. A blank dashboard is never the "working correctly" state.
- **React-observable.** The `isMock: boolean` field in the return value is a plain value that travels through TanStack Query's cache and into component props. React re-renders correctly when it changes.
- **Catches backend regressions.** Because the real API is always tried first, a broken endpoint surfaces immediately as a `console.error` or `console.warn` in DevTools, even if the UI continues to show mock data.
- **Clean demo story.** The `demoMode` flag provides a deterministic path to fully predictable mock data for presentations and screenshots.

### Neutral

- **Mock data must be maintained.** Each data source requires a corresponding mock generator in `client/src/lib/mock-data/`. This is a small, bounded maintenance cost per new dashboard feature.
- **"Mixed" dashboards are possible.** A dashboard may show real data for some widgets and mock data for others if some endpoints have data and others do not. This is intentional and truthful, but may be initially surprising.

### Negative

- **Extra network request in development.** Every page load makes a real HTTP request even when no infrastructure is running. The request fails fast (network timeout or immediate connection refused), so the latency impact is small, but it is nonzero.
- **`isMock` must be threaded through call sites.** Components that want to show a "Demo data" indicator must accept and render `isMock`. This is a minor but real surface-area cost for each new dashboard component.

---

## Alternatives Considered

### Alternative 1: Pure Mock Data (Original Approach)

**Pattern**: Data sources return mock data directly; no API calls in development.

**Rejected because**:
- Hides API bugs until explicit integration testing.
- Provides no feedback about whether infrastructure is healthy.
- All dashboards look identical regardless of whether they are connected to real data.

### Alternative 2: Environment Flag to Switch Between Mock and Real

**Pattern**: A build-time or runtime environment variable (`VITE_USE_MOCK_DATA=true`) selects either pure mock or pure real.

**Rejected because**:
- Creates two separate code paths that diverge over time.
- Developers running with mock data never exercise the real API surface.
- "Real with empty tables" is a valid and common state that this approach mishandles (would show blank charts or errors).

### Alternative 3: Mutable `Set`-Based Mock Tracking (Earlier Pattern)

**Pattern**: A mutable `Set<string>` on the source class tracks which endpoints fell back to mock. A `isUsingMockData` getter checks `set.size > 0`.

**Rejected because**:
- Mutating a `Set` in-place does not trigger React re-renders. The UI may display stale information about mock status.
- The mock-tracking state is decoupled from the data value; they can drift out of sync if a fetch is cancelled or retried.
- The `{ data, isMock }` discriminated union keeps mock status co-located with the data it describes.

---

## References

### Related Files

- `client/src/lib/data-sources/extraction-source.ts` — canonical implementation of the pattern
- `client/src/lib/data-sources/baselines-source.ts` — example of `mockOnEmpty` on primary, not secondary endpoints
- `client/src/lib/mock-data/` — mock data generators for each dashboard domain
- `client/src/lib/data-sources/api-base.ts` — shared URL construction utility

### Tickets

- OMN-2304 — Added mock fallback to extraction dashboard
- OMN-2298 — Global `demoMode` flag
- OMN-2156 — Baselines source following same pattern

---

## Approval

**Implemented By**: Omnidash Engineering Team
**Date**: 2026-01
**Version**: 1.0

---

## Changelog

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-01 | Initial ADR | Omnidash Team |

---

**Next Review**: 2026-07-01
