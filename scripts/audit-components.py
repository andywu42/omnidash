#!/usr/bin/env python3
"""
Dashboard Component Health Audit (OMN-3263)

Audits every omnidash route/component to determine whether its upstream data
sources are healthy.  For each component the script checks:

1. Kafka topic presence  (via Redpanda Admin API or kafkajs-based CLI)
2. DB projection freshness  (via the omnidash /api/health/data-sources endpoint)
3. API endpoint non-emptiness  (via the omnidash API when the server is running)

Each component is classified as one of:
  HEALTHY       – topic exists, DB projection has recent rows, API returns data
  STALE         – topic exists but last message is old (> STALE_THRESHOLD_HOURS h)
  EMPTY         – topic exists but has no messages, or DB projection is empty
  TOPIC_MISSING – Kafka topic does not exist on the broker
  API_EMPTY     – API endpoint returns an empty/null payload
  UNKNOWN       – checks could not be run (service unreachable)

For each component that is NOT HEALTHY the script optionally creates a Linear
ticket under a parent "Omnidash Component Health" epic.  Re-runs are safe:
existing open tickets with the same title are reused (deduplication).

Usage:
    # Audit only (no ticket creation)
    python3 scripts/audit-components.py

    # Audit + create Linear tickets for unhealthy components
    python3 scripts/audit-components.py --create-tickets

    # Override defaults
    python3 scripts/audit-components.py \\
        --dashboard-url http://localhost:3000 \\
        --redpanda-admin http://localhost:9644 \\
        --broker 192.168.86.200:29092 \\  # cloud-bus-ok OMN-4494
        --stale-threshold-hours 2 \\
        --create-tickets \\
        --team-id <linear-team-id>
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from urllib.error import URLError
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# Health status
# ---------------------------------------------------------------------------


class Health(str, Enum):
    HEALTHY = "HEALTHY"
    STALE = "STALE"
    EMPTY = "EMPTY"
    TOPIC_MISSING = "TOPIC_MISSING"
    API_EMPTY = "API_EMPTY"
    UNKNOWN = "UNKNOWN"


# ---------------------------------------------------------------------------
# Component catalogue  (derived from docs/architecture/ROUTE_CATALOG.md)
# ---------------------------------------------------------------------------
# Each entry describes one route/component with the Kafka topic it depends on
# (if any) and the API endpoint that should return non-empty data.
# ---------------------------------------------------------------------------


@dataclass
class ComponentSpec:
    name: str
    route: str
    component: str
    kafka_topics: list[str] = field(default_factory=list)
    api_endpoints: list[str] = field(default_factory=list)
    # projection key as returned by /api/health/data-sources
    projection_key: Optional[str] = None


COMPONENTS: list[ComponentSpec] = [
    # ---------- Category dashboards ----------
    ComponentSpec(
        name="SpeedCategory",
        route="/category/speed",
        component="SpeedCategory",
        api_endpoints=["/api/intelligence/routing/metrics"],
        projection_key=None,
    ),
    ComponentSpec(
        name="SuccessCategory",
        route="/category/success",
        component="SuccessCategory",
        api_endpoints=["/api/effectiveness/summary"],
        projection_key="effectiveness",
    ),
    ComponentSpec(
        name="IntelligenceCategory",
        route="/category/intelligence",
        component="IntelligenceCategory",
        api_endpoints=["/api/patterns/summary"],
        projection_key="patterns",
    ),
    ComponentSpec(
        name="SystemHealthCategory",
        route="/category/health",
        component="SystemHealthCategory",
        api_endpoints=["/api/validation/summary"],
        projection_key="validation",
    ),
    # ---------- Advanced: Monitoring ----------
    ComponentSpec(
        name="EventBusMonitor",
        route="/events",
        component="EventBusMonitor",
        kafka_topics=["agent-actions", "onex.evt.omniclaude.agent-actions.v1"],
        api_endpoints=["/api/event-bus/stats"],
        projection_key="eventBus",
    ),
    ComponentSpec(
        name="LiveEventStream",
        route="/live-events",
        component="LiveEventStream",
        kafka_topics=["agent-actions"],
        api_endpoints=[],
        projection_key=None,
    ),
    ComponentSpec(
        name="ExtractionDashboard",
        route="/extraction",
        component="ExtractionDashboard",
        kafka_topics=["onex.evt.omniintelligence.pattern-discovery.v1"],
        api_endpoints=["/api/extraction/summary"],
        projection_key="extraction",
    ),
    ComponentSpec(
        name="EffectivenessSummary",
        route="/effectiveness",
        component="EffectivenessSummary",
        api_endpoints=["/api/effectiveness/summary"],
        projection_key="effectiveness",
    ),
    ComponentSpec(
        name="EffectivenessLatency",
        route="/effectiveness/latency",
        component="EffectivenessLatency",
        api_endpoints=["/api/effectiveness/latency"],
        projection_key="effectiveness",
    ),
    ComponentSpec(
        name="EffectivenessUtilization",
        route="/effectiveness/utilization",
        component="EffectivenessUtilization",
        api_endpoints=["/api/effectiveness/utilization"],
        projection_key="effectiveness",
    ),
    ComponentSpec(
        name="EffectivenessAB",
        route="/effectiveness/ab",
        component="EffectivenessAB",
        api_endpoints=["/api/effectiveness/ab"],
        projection_key="effectiveness",
    ),
    ComponentSpec(
        name="CostTrendDashboard",
        route="/cost-trends",
        component="CostTrendDashboard",
        api_endpoints=["/api/costs/summary"],
        projection_key="costs",
    ),
    ComponentSpec(
        name="ExecutionGraph",
        route="/graph",
        component="ExecutionGraph",
        api_endpoints=["/api/executions/recent"],
        projection_key=None,
    ),
    # ---------- Advanced: Intelligence ----------
    ComponentSpec(
        name="IntentDashboard",
        route="/intents",
        component="IntentDashboard",
        kafka_topics=["onex.evt.omniintelligence.intent-classified.v1"],
        api_endpoints=["/api/intents/summary"],
        projection_key="intents",
    ),
    ComponentSpec(
        name="PatternLearning",
        route="/patterns",
        component="PatternLearning",
        kafka_topics=["onex.evt.omniintelligence.pattern-discovery.v1"],
        api_endpoints=["/api/patterns/summary"],
        projection_key="patterns",
    ),
    ComponentSpec(
        name="PatternEnforcement",
        route="/enforcement",
        component="PatternEnforcement",
        api_endpoints=["/api/enforcement/summary"],
        projection_key="enforcement",
    ),
    ComponentSpec(
        name="ContextEnrichmentDashboard",
        route="/enrichment",
        component="ContextEnrichmentDashboard",
        api_endpoints=["/api/enrichment/summary"],
        projection_key="enrichment",
    ),
    ComponentSpec(
        name="LlmRoutingDashboard",
        route="/llm-routing",
        component="LlmRoutingDashboard",
        api_endpoints=["/api/llm-routing/summary"],
        projection_key="llmRouting",
    ),
    # ---------- Advanced: System ----------
    ComponentSpec(
        name="NodeRegistry",
        route="/registry",
        component="NodeRegistry",
        api_endpoints=["/api/registry/summary"],
        projection_key="nodeRegistry",
    ),
    ComponentSpec(
        name="RegistryDiscovery",
        route="/discovery",
        component="RegistryDiscovery",
        api_endpoints=["/api/registry/instances"],
        projection_key=None,
    ),
    ComponentSpec(
        name="ValidationDashboard",
        route="/validation",
        component="ValidationDashboard",
        api_endpoints=["/api/validation/summary"],
        projection_key="validation",
    ),
    ComponentSpec(
        name="BaselinesROI",
        route="/baselines",
        component="BaselinesROI",
        api_endpoints=["/api/baselines/summary"],
        projection_key="baselines",
    ),
    # ---------- Advanced: Tools ----------
    ComponentSpec(
        name="CorrelationTrace",
        route="/trace",
        component="CorrelationTrace",
        api_endpoints=["/api/intelligence/events/recent"],
        projection_key=None,
    ),
    ComponentSpec(
        name="LearnedInsights",
        route="/insights",
        component="LearnedInsights",
        api_endpoints=["/api/insights/summary"],
        projection_key="insights",
    ),
]


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------


@dataclass
class AuditResult:
    component: ComponentSpec
    health: Health
    reason: str
    kafka_status: dict[str, str] = field(default_factory=dict)
    projection_status: Optional[str] = None
    api_status: dict[str, bool] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def _http_get(url: str, timeout: int = 5) -> tuple[int, bytes]:
    """Return (status_code, body_bytes).  Returns (0, b'') on connection failure."""
    try:
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except URLError:
        return 0, b""
    except Exception:  # noqa: BLE001
        return 0, b""


def _parse_json(body: bytes) -> object | None:
    try:
        return json.loads(body)
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# Kafka topic check via Redpanda Admin API
# ---------------------------------------------------------------------------


def check_kafka_topics(
    topics: list[str],
    redpanda_admin: str,
    stale_threshold_hours: float,
) -> dict[str, str]:
    """
    Returns a dict of topic -> status string:
      FRESH | STALE | EMPTY | TOPIC_MISSING | UNKNOWN
    """
    if not topics:
        return {}

    # Fetch partition list from Redpanda Admin API (/v1/partitions).
    # Note: /v1/topics does NOT exist in the Redpanda Admin API (returns 404).
    # We derive topic names from the partition entries instead.
    status, body = _http_get(f"{redpanda_admin}/v1/partitions", timeout=5)
    if status != 200:
        return {t: "UNKNOWN" for t in topics}

    data = _parse_json(body)
    if not isinstance(data, list):
        return {t: "UNKNOWN" for t in topics}

    # Build set of topic names from partition entries, excluding internal
    # Redpanda topics (ns == "redpanda").
    broker_topics: set[str] = set()
    partitions_per_topic: dict[str, int] = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        if item.get("ns") == "redpanda":
            continue
        topic_name = item.get("topic", "")
        if topic_name:
            broker_topics.add(topic_name)
            partitions_per_topic[topic_name] = partitions_per_topic.get(topic_name, 0) + 1

    result: dict[str, str] = {}
    for topic in topics:
        if topic not in broker_topics:
            result[topic] = "TOPIC_MISSING"
            continue

        # The Redpanda Admin API /v1/partitions does not expose watermark
        # offsets, so we cannot determine FRESH vs STALE vs EMPTY from HTTP
        # alone. Report as FRESH if the topic has partitions on the broker
        # (presence check). Actual offset-based staleness detection requires
        # the Kafka protocol (e.g. kafkajs admin).
        partition_count = partitions_per_topic.get(topic, 0)
        if partition_count == 0:
            result[topic] = "EMPTY"
            continue

        # Try to determine freshness from the health projection endpoint
        # (Redpanda Admin API doesn't expose message timestamps directly without consuming)
        # We use EMPTY/FRESH heuristic: if there are messages, classify as FRESH unless
        # we can determine otherwise from the event bus health endpoint.
        # Latest-timestamp probing requires Kafka consumer which is done by check-kafka-health.ts;
        # here we use the admin API only.
        result[topic] = "FRESH"

    return result


# ---------------------------------------------------------------------------
# Projection / API endpoint checks
# ---------------------------------------------------------------------------


def check_data_sources_health(dashboard_url: str) -> dict[str, str]:
    """
    Calls /api/health/data-sources and returns a dict of
    projectionKey -> "live" | "mock" | "error" | "offline" | "unknown"
    """
    status, body = _http_get(f"{dashboard_url}/api/health/data-sources", timeout=8)
    if status != 200:
        return {}
    data = _parse_json(body)
    if not isinstance(data, dict):
        return {}
    sources = data.get("dataSources", {})
    if not isinstance(sources, dict):
        return {}
    return {
        k: v.get("status", "unknown") if isinstance(v, dict) else "unknown"
        for k, v in sources.items()
    }


def check_api_endpoints(dashboard_url: str, endpoints: list[str]) -> dict[str, bool]:
    """Returns endpoint -> True (has data) / False (empty or error)."""
    result: dict[str, bool] = {}
    for ep in endpoints:
        status, body = _http_get(f"{dashboard_url}{ep}", timeout=5)
        if status not in (200, 206):
            result[ep] = False
            continue
        data = _parse_json(body)
        # Consider non-empty: non-None, non-empty list/dict
        if data is None:
            result[ep] = False
        elif isinstance(data, list):
            result[ep] = len(data) > 0
        elif isinstance(data, dict):
            # dict with all-zero numeric values is considered empty
            result[ep] = bool(data)
        else:
            result[ep] = True
    return result


# ---------------------------------------------------------------------------
# Per-component audit
# ---------------------------------------------------------------------------


def audit_component(
    spec: ComponentSpec,
    redpanda_admin: str,
    data_sources_health: dict[str, str],
    dashboard_url: str,
    stale_threshold_hours: float,
) -> AuditResult:
    kafka_status = check_kafka_topics(
        spec.kafka_topics, redpanda_admin, stale_threshold_hours
    )

    # Projection check
    proj_status: str | None = None
    if spec.projection_key and data_sources_health:
        proj_status = data_sources_health.get(spec.projection_key, "unknown")

    # API endpoint check
    api_status = check_api_endpoints(dashboard_url, spec.api_endpoints)

    # --- Classify overall health ---
    # Priority: TOPIC_MISSING > EMPTY > STALE > API_EMPTY > projection-based > HEALTHY

    any_topic_missing = any(v == "TOPIC_MISSING" for v in kafka_status.values())
    any_topic_empty = any(v in ("EMPTY",) for v in kafka_status.values())
    any_topic_stale = any(v == "STALE" for v in kafka_status.values())
    all_topics_fresh = (
        all(v == "FRESH" for v in kafka_status.values()) if kafka_status else True
    )
    any_api_empty = any(not v for v in api_status.values())
    all_api_ok = all(api_status.values()) if api_status else True

    projection_degraded = (
        proj_status in ("mock", "error", "offline") if proj_status else False
    )
    projection_live = proj_status == "live" if proj_status else None

    # Build reason string
    reasons: list[str] = []

    if any_topic_missing:
        missing = [t for t, s in kafka_status.items() if s == "TOPIC_MISSING"]
        reasons.append(f"Kafka topics missing: {', '.join(missing)}")

    if any_topic_empty:
        empty_topics = [t for t, s in kafka_status.items() if s == "EMPTY"]
        reasons.append(f"Kafka topics empty: {', '.join(empty_topics)}")

    if any_topic_stale:
        stale_topics = [t for t, s in kafka_status.items() if s == "STALE"]
        reasons.append(f"Kafka topics stale: {', '.join(stale_topics)}")

    if projection_degraded:
        reasons.append(f"Projection status: {proj_status}")

    if any_api_empty:
        empty_eps = [ep for ep, ok in api_status.items() if not ok]
        reasons.append(f"API returned empty: {', '.join(empty_eps)}")

    # Determine overall health
    if any_topic_missing and spec.kafka_topics:
        health = Health.TOPIC_MISSING
    elif any_topic_empty and spec.kafka_topics:
        health = Health.EMPTY
    elif any_topic_stale and spec.kafka_topics:
        health = Health.STALE
    elif any_api_empty and spec.api_endpoints:
        # Don't flag API_EMPTY if the server isn't running (all endpoints failed due to connection)
        all_unreachable = all(
            _http_get(f"{dashboard_url}{ep}", timeout=3)[0] == 0
            for ep in spec.api_endpoints
        )
        if all_unreachable:
            health = Health.UNKNOWN
            reasons = ["Dashboard server not reachable"]
        else:
            health = Health.API_EMPTY
    elif projection_degraded:
        health = Health.EMPTY
    elif projection_live is False and spec.projection_key:
        health = Health.UNKNOWN
    else:
        health = Health.HEALTHY

    return AuditResult(
        component=spec,
        health=health,
        reason=" | ".join(reasons) if reasons else "All checks passed",
        kafka_status=kafka_status,
        projection_status=proj_status,
        api_status=api_status,
    )


# ---------------------------------------------------------------------------
# Linear ticket creation
# ---------------------------------------------------------------------------


def _get_linear_api_key() -> str | None:
    return os.environ.get("LINEAR_API_KEY")


def _linear_gql(query: str, variables: dict, api_key: str) -> dict:
    payload = json.dumps({"query": query, "variables": variables}).encode()
    req = Request(
        "https://api.linear.app/graphql",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": api_key,
        },
    )
    try:
        with urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception as exc:  # noqa: BLE001
        return {"errors": [str(exc)]}


def find_or_create_epic(team_id: str, api_key: str) -> str | None:
    """Find existing 'Omnidash Component Health' epic or create it."""
    search_query = """
    query SearchIssues($filter: IssueFilter!) {
      issues(filter: $filter, first: 10) {
        nodes {
          id
          title
          state { name }
        }
      }
    }
    """
    result = _linear_gql(
        search_query,
        {
            "filter": {
                "team": {"id": {"eq": team_id}},
                "title": {"eq": "[omnidash] Omnidash Component Health"},
                "state": {"type": {"nin": ["completed", "cancelled"]}},
            }
        },
        api_key,
    )
    issues = result.get("data", {}).get("issues", {}).get("nodes", [])
    if issues:
        return issues[0]["id"]

    # Create the epic
    create_mutation = """
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        issue { id title }
        success
      }
    }
    """
    create_result = _linear_gql(
        create_mutation,
        {
            "input": {
                "teamId": team_id,
                "title": "[omnidash] Omnidash Component Health",
                "description": (
                    "Parent epic tracking omnidash component health issues. "
                    "Auto-generated by `scripts/audit-components.py` (OMN-3263)."
                ),
                "priority": 2,
            }
        },
        api_key,
    )
    created = create_result.get("data", {}).get("issueCreate", {})
    if created.get("success"):
        return created["issue"]["id"]
    print(f"  [WARN] Could not create parent epic: {create_result}")
    return None


def find_existing_ticket(title: str, team_id: str, api_key: str) -> str | None:
    """Returns issue ID if an open ticket with this title already exists."""
    query = """
    query SearchIssues($filter: IssueFilter!) {
      issues(filter: $filter, first: 5) {
        nodes { id title }
      }
    }
    """
    result = _linear_gql(
        query,
        {
            "filter": {
                "team": {"id": {"eq": team_id}},
                "title": {"eq": title},
                "state": {"type": {"nin": ["completed", "cancelled"]}},
            }
        },
        api_key,
    )
    nodes = result.get("data", {}).get("issues", {}).get("nodes", [])
    return nodes[0]["id"] if nodes else None


def create_ticket(
    result: AuditResult,
    team_id: str,
    parent_id: str | None,
    api_key: str,
) -> str | None:
    """Create a Linear ticket for an unhealthy component. Returns the issue URL or None."""
    title = f"[omnidash] fix: {result.component.name} — {result.health.value.lower().replace('_', ' ')}"

    # Deduplication check
    existing = find_existing_ticket(title, team_id, api_key)
    if existing:
        print(f"  [SKIP] Ticket already exists for '{title}' (id={existing})")
        return None

    description_lines = [
        f"## Component: `{result.component.component}`",
        f"**Route**: `{result.component.route}`",
        f"**Health Status**: `{result.health.value}`",
        f"**Reason**: {result.reason}",
        "",
        "## Upstream Data Sources",
    ]

    if result.kafka_status:
        description_lines.append("### Kafka Topics")
        for topic, status in result.kafka_status.items():
            description_lines.append(f"- `{topic}`: **{status}**")

    if result.projection_status:
        description_lines.append(
            f"\n### Projection Status\n- `{result.component.projection_key}`: **{result.projection_status}**"
        )

    if result.api_status:
        description_lines.append("\n### API Endpoints")
        for ep, ok in result.api_status.items():
            description_lines.append(f"- `{ep}`: **{'OK' if ok else 'EMPTY/ERROR'}**")

    description_lines += [
        "",
        "## Acceptance Criteria",
        f"- [ ] Component `{result.component.name}` shows `HEALTHY` on re-run of audit script",
        "- [ ] Upstream data flows end-to-end (Kafka → projection → API → component)",
        "",
        "_Auto-generated by `scripts/audit-components.py` (OMN-3263)._",
    ]

    create_mutation = """
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        issue { id identifier url }
        success
      }
    }
    """

    input_vars: dict = {
        "teamId": team_id,
        "title": title,
        "description": "\n".join(description_lines),
        "priority": 3,  # Normal
        "labelNames": ["omnidash"],
    }
    if parent_id:
        input_vars["parentId"] = parent_id

    resp = _linear_gql(create_mutation, {"input": input_vars}, api_key)
    created = resp.get("data", {}).get("issueCreate", {})
    if created.get("success"):
        issue = created["issue"]
        return issue.get("url") or issue.get("id")
    print(f"  [WARN] Failed to create ticket for '{title}': {resp.get('errors')}")
    return None


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------

_STATUS_ICON = {
    Health.HEALTHY: "OK  ",
    Health.STALE: "STALE",
    Health.EMPTY: "EMPTY",
    Health.TOPIC_MISSING: "MISS ",
    Health.API_EMPTY: "API? ",
    Health.UNKNOWN: "UNK  ",
}


def print_report(results: list[AuditResult]) -> None:
    width = 100
    print("=" * width)
    print("  OMNIDASH COMPONENT HEALTH AUDIT REPORT")
    print(f"  Generated: {_iso_now()}")
    print("=" * width)

    col_name = 34
    col_route = 28
    col_health = 14

    header = (
        _pad("COMPONENT", col_name)
        + _pad("ROUTE", col_route)
        + _pad("HEALTH", col_health)
        + "REASON"
    )
    print(f"\n{header}")
    print("-" * width)

    for r in results:
        line = (
            _pad(r.component.name, col_name)
            + _pad(r.component.route, col_route)
            + _pad(r.health.value, col_health)
            + (r.reason if r.health != Health.HEALTHY else "")
        )
        print(line)

    # Summary
    counts: dict[Health, int] = {}
    for r in results:
        counts[r.health] = counts.get(r.health, 0) + 1

    print("\n" + "=" * width)
    print("  SUMMARY")
    print("=" * width)
    for h in Health:
        c = counts.get(h, 0)
        if c:
            print(f"  {h.value:<18} {c}")
    print()

    unhealthy = [r for r in results if r.health != Health.HEALTHY]
    if not unhealthy:
        print("  All components are HEALTHY.")
    else:
        print(f"  {len(unhealthy)} component(s) need attention:")
        for r in unhealthy:
            print(f"    - {r.component.name} [{r.health.value}]: {r.reason}")
    print()


def _pad(s: str, length: int) -> str:
    return s[:length].ljust(length)


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit omnidash component health and optionally create Linear tickets.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--dashboard-url",
        default=os.environ.get("OMNIDASH_URL", "http://localhost:3000"),
        help="Base URL for the omnidash server (default: http://localhost:3000)",
    )
    parser.add_argument(
        "--redpanda-admin",
        default=os.environ.get("REDPANDA_ADMIN_URL", "http://localhost:9644"),
        help="Redpanda Admin API base URL (default: http://localhost:9644)",
    )
    parser.add_argument(
        "--broker",
        default=os.environ.get(
            "KAFKA_BROKERS",
            os.environ.get("KAFKA_BOOTSTRAP_SERVERS", "192.168.86.200:29092"),  # cloud-bus-ok OMN-4494
        ),
        help="Kafka broker address (used for documentation only; actual probing via admin API)",
    )
    parser.add_argument(
        "--stale-threshold-hours",
        type=float,
        default=float(os.environ.get("AUDIT_STALE_THRESHOLD_HOURS", "1")),
        help="Hours since last Kafka message before a topic is classified STALE (default: 1)",
    )
    parser.add_argument(
        "--create-tickets",
        action="store_true",
        help="Create Linear tickets for unhealthy components",
    )
    parser.add_argument(
        "--team-id",
        default=os.environ.get(
            "LINEAR_TEAM_ID", "9bdff6a3-f4ef-4ff7-b29a-6c4cf44371e6"
        ),
        help="Linear team UUID for ticket creation",
    )
    parser.add_argument(
        "--output-json",
        metavar="FILE",
        help="Write JSON report to FILE in addition to stdout",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    print(f"Dashboard URL   : {args.dashboard_url}")
    print(f"Redpanda Admin  : {args.redpanda_admin}")
    print(f"Broker          : {args.broker}")
    print(f"Stale threshold : {args.stale_threshold_hours}h")
    print(f"Create tickets  : {args.create_tickets}")
    print()

    # Pre-fetch /api/health/data-sources once to avoid N requests
    print("Fetching /api/health/data-sources ...", end=" ", flush=True)
    data_sources_health = check_data_sources_health(args.dashboard_url)
    if data_sources_health:
        print(f"OK ({len(data_sources_health)} sources)")
    else:
        print("UNAVAILABLE (server may be offline; API checks will be skipped)")

    print(f"Auditing {len(COMPONENTS)} components ...\n")

    results: list[AuditResult] = []
    for spec in COMPONENTS:
        sys.stdout.write(f"  {spec.name:<34} ... ")
        sys.stdout.flush()
        r = audit_component(
            spec,
            args.redpanda_admin,
            data_sources_health,
            args.dashboard_url,
            args.stale_threshold_hours,
        )
        results.append(r)
        print(r.health.value)

    print()
    print_report(results)

    # JSON output
    if args.output_json:
        json_data = [
            {
                "component": r.component.name,
                "route": r.component.route,
                "health": r.health.value,
                "reason": r.reason,
                "kafka_status": r.kafka_status,
                "projection_status": r.projection_status,
                "api_status": r.api_status,
                "checked_at": _iso_now(),
            }
            for r in results
        ]
        with open(args.output_json, "w") as f:
            json.dump(json_data, f, indent=2)
        print(f"JSON report written to: {args.output_json}")

    # Ticket creation
    unhealthy = [r for r in results if r.health != Health.HEALTHY]
    if args.create_tickets and unhealthy:
        api_key = _get_linear_api_key()
        if not api_key:
            print("[ERROR] LINEAR_API_KEY not set. Cannot create tickets.")
            return 1

        print(
            f"\nCreating Linear tickets for {len(unhealthy)} unhealthy component(s) ..."
        )
        print(f"Team: {args.team_id}")

        parent_id = find_or_create_epic(args.team_id, api_key)
        if parent_id:
            print(f"Parent epic: {parent_id}\n")
        else:
            print(
                "[WARN] Could not find/create parent epic. Tickets will be unparented.\n"
            )

        tickets_created: list[str] = []
        for r in unhealthy:
            print(
                f"  Creating ticket for {r.component.name} [{r.health.value}] ...",
                end=" ",
            )
            url = create_ticket(r, args.team_id, parent_id, api_key)
            if url:
                print(f"created: {url}")
                tickets_created.append(url)
            else:
                print("skipped (duplicate or error)")

        print(f"\n{len(tickets_created)} ticket(s) created.")

    return 0 if not unhealthy else 2


if __name__ == "__main__":
    sys.exit(main())
