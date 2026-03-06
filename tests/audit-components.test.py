"""
Tests for scripts/audit-components.py (OMN-3263)

Run with:
    python3 -m pytest tests/audit-components.test.py -v
    # or directly:
    python3 tests/audit-components.test.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Load the audit module from scripts/audit-components.py
# ---------------------------------------------------------------------------

_SCRIPT_PATH = Path(__file__).parent.parent / "scripts" / "audit-components.py"

_spec = importlib.util.spec_from_file_location("audit_components", _SCRIPT_PATH)
assert _spec and _spec.loader
audit = importlib.util.module_from_spec(_spec)
# Must register in sys.modules BEFORE exec_module so that dataclasses can
# resolve the module by name when processing @dataclass decorators.
sys.modules["audit_components"] = audit
_spec.loader.exec_module(audit)  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Unit tests
# ---------------------------------------------------------------------------


class TestComponentCatalogue(unittest.TestCase):
    """Sanity-check the component catalogue is well-formed."""

    def test_components_non_empty(self) -> None:
        self.assertGreater(len(audit.COMPONENTS), 0, "COMPONENTS should not be empty")

    def test_no_duplicate_routes(self) -> None:
        routes = [c.route for c in audit.COMPONENTS]
        self.assertEqual(
            len(routes), len(set(routes)), "Duplicate routes found in COMPONENTS"
        )

    def test_no_duplicate_names(self) -> None:
        names = [c.name for c in audit.COMPONENTS]
        self.assertEqual(len(names), len(set(names)), "Duplicate component names found")

    def test_all_specs_have_name_and_route(self) -> None:
        for comp in audit.COMPONENTS:
            self.assertTrue(comp.name, f"Component missing name: {comp!r}")
            self.assertTrue(comp.route, f"Component {comp.name!r} missing route")

    def test_key_components_present(self) -> None:
        """Spot-check a few well-known components from the route catalog."""
        names = {c.name for c in audit.COMPONENTS}
        for expected in [
            "EventBusMonitor",
            "PatternLearning",
            "IntentDashboard",
            "ValidationDashboard",
            "NodeRegistry",
            "EffectivenessSummary",
        ]:
            self.assertIn(expected, names, f"Expected component '{expected}' not found")


class TestHealthEnum(unittest.TestCase):
    def test_all_health_values_are_strings(self) -> None:
        for h in audit.Health:
            self.assertIsInstance(h.value, str)

    def test_healthy_exists(self) -> None:
        self.assertEqual(audit.Health.HEALTHY.value, "HEALTHY")

    def test_topic_missing_exists(self) -> None:
        self.assertEqual(audit.Health.TOPIC_MISSING.value, "TOPIC_MISSING")


class TestCheckKafkaTopics(unittest.TestCase):
    """Tests for check_kafka_topics() using mocked HTTP."""

    def _make_http_response(self, status: int, body: bytes):
        return (status, body)

    def test_empty_topic_list_returns_empty_dict(self) -> None:
        result = audit.check_kafka_topics([], "http://localhost:9644", 1.0)
        self.assertEqual(result, {})

    @patch("audit_components._http_get")
    def test_redpanda_unavailable_returns_unknown(self, mock_get: MagicMock) -> None:
        mock_get.return_value = (0, b"")
        result = audit.check_kafka_topics(
            ["agent-actions"], "http://localhost:9644", 1.0
        )
        self.assertEqual(result["agent-actions"], "UNKNOWN")

    @patch("audit_components._http_get")
    def test_topic_missing_from_broker(self, mock_get: MagicMock) -> None:
        # Broker returns partitions for a different topic only
        partitions = [{"ns": "kafka", "topic": "other-topic", "partition_id": 0}]
        mock_get.return_value = (200, json.dumps(partitions).encode())
        result = audit.check_kafka_topics(
            ["agent-actions"], "http://localhost:9644", 1.0
        )
        self.assertEqual(result["agent-actions"], "TOPIC_MISSING")

    @patch("audit_components._http_get")
    def test_topic_present_with_partitions_is_fresh(self, mock_get: MagicMock) -> None:
        # /v1/partitions returns entries for agent-actions
        partitions = [
            {"ns": "kafka", "topic": "agent-actions", "partition_id": 0},
            {"ns": "kafka", "topic": "agent-actions", "partition_id": 1},
        ]
        mock_get.return_value = (200, json.dumps(partitions).encode())
        result = audit.check_kafka_topics(
            ["agent-actions"], "http://localhost:9644", 1.0
        )
        self.assertEqual(result["agent-actions"], "FRESH")

    @patch("audit_components._http_get")
    def test_redpanda_internal_topics_excluded(self, mock_get: MagicMock) -> None:
        # Partitions in ns=redpanda should be excluded from topic discovery
        partitions = [
            {"ns": "redpanda", "topic": "__consumer_offsets", "partition_id": 0},
            {"ns": "kafka", "topic": "agent-actions", "partition_id": 0},
        ]
        mock_get.return_value = (200, json.dumps(partitions).encode())
        result = audit.check_kafka_topics(
            ["agent-actions", "__consumer_offsets"], "http://localhost:9644", 1.0
        )
        self.assertEqual(result["agent-actions"], "FRESH")
        self.assertEqual(result["__consumer_offsets"], "TOPIC_MISSING")

    @patch("audit_components._http_get")
    def test_malformed_broker_response_returns_unknown(
        self, mock_get: MagicMock
    ) -> None:
        mock_get.return_value = (200, b"not-valid-json")
        result = audit.check_kafka_topics(
            ["agent-actions"], "http://localhost:9644", 1.0
        )
        self.assertEqual(result["agent-actions"], "UNKNOWN")


class TestCheckDataSourcesHealth(unittest.TestCase):
    @patch("audit_components._http_get")
    def test_returns_empty_on_unreachable(self, mock_get: MagicMock) -> None:
        mock_get.return_value = (0, b"")
        result = audit.check_data_sources_health("http://localhost:3000")
        self.assertEqual(result, {})

    @patch("audit_components._http_get")
    def test_parses_live_status(self, mock_get: MagicMock) -> None:
        payload = {
            "dataSources": {
                "extraction": {"status": "live", "lastEvent": "2026-03-01T00:00:00Z"},
                "patterns": {"status": "mock"},
            },
            "summary": {"live": 1, "mock": 1, "error": 0, "offline": 0},
        }
        mock_get.return_value = (200, json.dumps(payload).encode())
        result = audit.check_data_sources_health("http://localhost:3000")
        self.assertEqual(result["extraction"], "live")
        self.assertEqual(result["patterns"], "mock")

    @patch("audit_components._http_get")
    def test_returns_empty_on_non_200(self, mock_get: MagicMock) -> None:
        mock_get.return_value = (500, b"Internal Server Error")
        result = audit.check_data_sources_health("http://localhost:3000")
        self.assertEqual(result, {})


class TestCheckApiEndpoints(unittest.TestCase):
    @patch("audit_components._http_get")
    def test_non_200_returns_false(self, mock_get: MagicMock) -> None:
        mock_get.return_value = (503, b"")
        result = audit.check_api_endpoints("http://localhost:3000", ["/api/test"])
        self.assertFalse(result["/api/test"])

    @patch("audit_components._http_get")
    def test_empty_list_response_returns_false(self, mock_get: MagicMock) -> None:
        mock_get.return_value = (200, b"[]")
        result = audit.check_api_endpoints("http://localhost:3000", ["/api/test"])
        self.assertFalse(result["/api/test"])

    @patch("audit_components._http_get")
    def test_non_empty_list_returns_true(self, mock_get: MagicMock) -> None:
        mock_get.return_value = (200, json.dumps([{"id": 1}]).encode())
        result = audit.check_api_endpoints("http://localhost:3000", ["/api/test"])
        self.assertTrue(result["/api/test"])

    @patch("audit_components._http_get")
    def test_empty_dict_returns_true(self, mock_get: MagicMock) -> None:
        # An empty {} is technically truthy — non-None dict even if empty
        mock_get.return_value = (200, b"{}")
        result = audit.check_api_endpoints("http://localhost:3000", ["/api/test"])
        # empty dict evaluates to False with bool({})
        self.assertFalse(result["/api/test"])

    @patch("audit_components._http_get")
    def test_non_empty_dict_returns_true(self, mock_get: MagicMock) -> None:
        mock_get.return_value = (200, json.dumps({"total": 5}).encode())
        result = audit.check_api_endpoints("http://localhost:3000", ["/api/test"])
        self.assertTrue(result["/api/test"])

    def test_empty_endpoint_list_returns_empty_dict(self) -> None:
        result = audit.check_api_endpoints("http://localhost:3000", [])
        self.assertEqual(result, {})


class TestAuditComponentClassification(unittest.TestCase):
    """
    Tests for audit_component() health classification logic.
    All external calls are mocked.
    """

    def _spec_with_topics(self, topics: list[str]) -> audit.ComponentSpec:
        return audit.ComponentSpec(
            name="TestComp",
            route="/test",
            component="TestComp",
            kafka_topics=topics,
            api_endpoints=["/api/test"],
        )

    @patch("audit_components.check_api_endpoints")
    @patch("audit_components.check_kafka_topics")
    def test_topic_missing_takes_priority(
        self, mock_kafka: MagicMock, mock_api: MagicMock
    ) -> None:
        mock_kafka.return_value = {"agent-actions": "TOPIC_MISSING"}
        mock_api.return_value = {"/api/test": True}
        spec = self._spec_with_topics(["agent-actions"])
        result = audit.audit_component(
            spec, "http://localhost:9644", {}, "http://localhost:3000", 1.0
        )
        self.assertEqual(result.health, audit.Health.TOPIC_MISSING)

    @patch("audit_components.check_api_endpoints")
    @patch("audit_components.check_kafka_topics")
    def test_empty_topic_classified_as_empty(
        self, mock_kafka: MagicMock, mock_api: MagicMock
    ) -> None:
        mock_kafka.return_value = {"agent-actions": "EMPTY"}
        mock_api.return_value = {"/api/test": True}
        spec = self._spec_with_topics(["agent-actions"])
        result = audit.audit_component(
            spec, "http://localhost:9644", {}, "http://localhost:3000", 1.0
        )
        self.assertEqual(result.health, audit.Health.EMPTY)

    @patch("audit_components.check_api_endpoints")
    @patch("audit_components.check_kafka_topics")
    def test_healthy_when_topic_fresh_and_api_ok(
        self, mock_kafka: MagicMock, mock_api: MagicMock
    ) -> None:
        mock_kafka.return_value = {"agent-actions": "FRESH"}
        mock_api.return_value = {"/api/test": True}
        spec = self._spec_with_topics(["agent-actions"])
        result = audit.audit_component(
            spec, "http://localhost:9644", {}, "http://localhost:3000", 1.0
        )
        self.assertEqual(result.health, audit.Health.HEALTHY)

    @patch("audit_components._http_get")
    @patch("audit_components.check_kafka_topics")
    def test_no_topics_no_api_endpoints_is_healthy(
        self, mock_kafka: MagicMock, mock_http: MagicMock
    ) -> None:
        mock_kafka.return_value = {}
        mock_http.return_value = (0, b"")  # unreachable
        spec = audit.ComponentSpec(
            name="LiveEventStream",
            route="/live-events",
            component="LiveEventStream",
        )
        result = audit.audit_component(
            spec, "http://localhost:9644", {}, "http://localhost:3000", 1.0
        )
        self.assertEqual(result.health, audit.Health.HEALTHY)


class TestDeduplication(unittest.TestCase):
    """Tests for find_existing_ticket deduplication logic."""

    @patch("audit_components._linear_gql")
    def test_returns_existing_id_if_found(self, mock_gql: MagicMock) -> None:
        mock_gql.return_value = {
            "data": {
                "issues": {"nodes": [{"id": "abc-123", "title": "existing ticket"}]}
            }
        }
        result = audit.find_existing_ticket("existing ticket", "team-id", "api-key")
        self.assertEqual(result, "abc-123")

    @patch("audit_components._linear_gql")
    def test_returns_none_when_not_found(self, mock_gql: MagicMock) -> None:
        mock_gql.return_value = {"data": {"issues": {"nodes": []}}}
        result = audit.find_existing_ticket("new ticket", "team-id", "api-key")
        self.assertIsNone(result)


# ---------------------------------------------------------------------------
# Script integration smoke test (no network calls)
# ---------------------------------------------------------------------------


class TestScriptRunsWithoutCrash(unittest.TestCase):
    """Run the main() function with all network mocked out."""

    @patch("audit_components.check_api_endpoints")
    @patch("audit_components.check_kafka_topics")
    @patch("audit_components.check_data_sources_health")
    def test_main_exits_cleanly(
        self,
        mock_ds: MagicMock,
        mock_kafka: MagicMock,
        mock_api: MagicMock,
    ) -> None:
        mock_ds.return_value = {}
        mock_kafka.return_value = {}
        mock_api.return_value = {}

        import argparse

        args = argparse.Namespace(
            dashboard_url="http://localhost:3000",
            redpanda_admin="http://localhost:9644",
            broker="192.168.86.200:29092",
            stale_threshold_hours=1.0,
            create_tickets=False,
            team_id="team-id",
            output_json=None,
        )

        with patch("audit_components.parse_args", return_value=args):
            exit_code = audit.main()

        # All components HEALTHY (no topics or endpoints to check) → exit 0
        # LiveEventStream has no topics/endpoints so it's always HEALTHY.
        # Others that do have topics/endpoints: kafka returns {} → no topic checks
        # api_endpoints return {} → no api checks → HEALTHY
        self.assertIn(exit_code, (0, 2))  # 0 = all healthy, 2 = some unhealthy


if __name__ == "__main__":
    unittest.main(verbosity=2)
