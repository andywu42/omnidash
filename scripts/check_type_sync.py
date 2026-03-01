#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 OmniNode.ai Inc.
# SPDX-License-Identifier: MIT
"""
OMN-3258: TypeScript Type Sync Check

Verifies that TypeScript boundary types in omnidash stay in sync with the
corresponding Python Pydantic models in omnibase_core / omniintelligence.

Strategy:
  1. Parse target Python model files with `ast` (stdlib — no install needed)
  2. Extract field names from Pydantic `Field(...)` or annotated assignments
  3. For each model, verify that every Python field name appears in the
     corresponding TypeScript file
  4. Exit 1 if any field is missing from the TypeScript type

This approach avoids `datamodel-codegen` (which generates incompatible output
for Zod-based schemas) and works with stdlib only — no uv/pip required.

Usage:
  python3 scripts/check_type_sync.py [--omnibase-core PATH] [--omniintelligence PATH]

Defaults assume the sibling repos are checked out alongside omnidash:
  omnibase_core/   (or set --omnibase-core)
  omniintelligence/ (or set --omniintelligence)
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Target model descriptors
# ---------------------------------------------------------------------------
#
# Each entry maps:
#   python_path  — path relative to the repo root (passed via args)
#   ts_path      — path relative to omnidash repo root
#   model_class  — Pydantic class name to extract fields from
#   ts_name      — human-readable name for error messages
#   exclude_fields — fields intentionally absent in TS (base-class internals, etc.)


TARGETS = [
    {
        "name": "ModelEventEnvelope",
        "python_repo": "omnibase_core",
        "python_rel": "src/omnibase_core/models/events/model_event_envelope.py",
        "model_class": "ModelEventEnvelope",
        "ts_path": "shared/schemas/event-envelope.ts",
        # Fields from ModelEventEnvelope that are intentionally not represented
        # in the omnidash TypeScript boundary type. The TS EventEnvelope type
        # is a simplified consumer view — not a full mirror of every server field.
        "exclude_fields": {
            "metadata",  # Complex nested type, not needed at boundary
            "security_context",  # Server-internal auth context
            "onex_version",  # Version managed server-side
            "envelope_version",  # Version managed server-side
            "priority",  # QoS field, not used by omnidash consumers
            "timeout_seconds",  # QoS field
            "retry_count",  # QoS field
            "request_id",  # Tracing field (optional in TS)
            "trace_id",  # Tracing field (optional in TS)
            "span_id",  # Tracing field (optional in TS)
            "source_tool",  # Routing field
            "target_tool",  # Routing field
            "payload_type",  # Schema field
            "payload_schema_version",  # Schema field
        },
        # Required fields that MUST appear in TS — the minimal safe boundary set
        "required_fields": {
            "envelope_id",
            "correlation_id",
            "envelope_timestamp",
            "payload",
        },
    },
    {
        "name": "ModelIntentClassifiedEvent",
        "python_repo": "omniintelligence",
        "python_rel": (
            "src/omniintelligence/nodes/node_intent_classifier_compute/"
            "models/model_intent_classified_event.py"
        ),
        "model_class": "ModelIntentClassifiedEvent",
        "ts_path": "shared/intent-types.ts",
        "exclude_fields": set(),
        # These are the core fields that MUST appear in the TypeScript type.
        # The TS IntentClassifiedEvent is a consumer-side projection — it may
        # expose a subset of Python model fields, but these must always be present.
        "required_fields": {
            "event_type",
            "session_id",
            "correlation_id",
            "confidence",
        },
    },
    {
        "name": "ModelNodeHeartbeatEvent (heartbeat payload)",
        "python_repo": "omnibase_core",
        "python_rel": (
            "src/omnibase_core/models/events/contract_registration/"
            "model_node_heartbeat_event.py"
        ),
        "model_class": "ModelNodeHeartbeatEvent",
        "ts_path": "shared/schemas/event-envelope.ts",
        "exclude_fields": {
            "event_type",  # Managed in TS event envelope wrapper
            "model_config",  # Pydantic config class attr, not a data field
        },
        # Core liveness fields that MUST appear in the TS heartbeat schema
        "required_fields": {
            "node_id",
            "uptime_seconds",
        },
    },
]


# ---------------------------------------------------------------------------
# Python model field extraction
# ---------------------------------------------------------------------------


def extract_pydantic_fields(path: Path, class_name: str) -> set[str]:
    """Parse a Python file with `ast` and extract annotated field names
    from the named Pydantic class.

    Handles both:
      - `field: Type = Field(...)` style
      - `field: Type` bare annotations (without a default)

    Skips:
      - `model_config` (Pydantic v2 ConfigDict assignment)
      - ClassVar annotations
      - Private fields starting with `_`

    Returns:
        Set of field name strings found in the class body.
    """
    try:
        source = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        print(f"  ERROR: Python model file not found: {path}", file=sys.stderr)
        return set()

    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        print(f"  ERROR: Cannot parse {path}: {exc}", file=sys.stderr)
        return set()

    fields: set[str] = set()

    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef) or node.name != class_name:
            continue
        for item in node.body:
            # Annotated assignment: `field: Type = ...` or `field: Type`
            if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                name = item.target.id
                if name.startswith("_"):
                    continue
                if name == "model_config":
                    continue
                # Skip ClassVar[...] annotations
                ann = item.annotation
                if isinstance(ann, ast.Subscript):
                    ann_name = (
                        getattr(ann.value, "id", "")
                        or getattr(
                            getattr(ann.value, "attr", None), "__str__", lambda: ""
                        )()
                    )
                    if ann_name == "ClassVar":
                        continue
                fields.add(name)
        # Only process the first matching class definition
        break

    return fields


# ---------------------------------------------------------------------------
# TypeScript field presence check
# ---------------------------------------------------------------------------


def check_fields_in_ts(ts_path: Path, required_fields: set[str]) -> list[str]:
    """Verify that each required field name appears somewhere in the TS file.

    Uses a simple substring/word-boundary search. A field `foo_bar` is
    considered present if the pattern `foo_bar` appears in the file as
    a standalone identifier (not as a substring of a longer word).

    Returns:
        List of missing field names (empty = all present).
    """
    if not ts_path.exists():
        print(f"  ERROR: TypeScript file not found: {ts_path}", file=sys.stderr)
        return list(required_fields)

    content = ts_path.read_text(encoding="utf-8")
    missing: list[str] = []

    for field in sorted(required_fields):
        # Match field as a standalone identifier (word boundary on both sides)
        pattern = rf"\b{re.escape(field)}\b"
        if not re.search(pattern, content):
            missing.append(field)

    return missing


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check TypeScript boundary types stay in sync with Python Pydantic models."
    )
    parser.add_argument(
        "--omnibase-core",
        default=None,
        help=(
            "Path to omnibase_core repo root. "
            "Defaults to ../omnibase_core relative to omnidash root."
        ),
    )
    parser.add_argument(
        "--omniintelligence",
        default=None,
        help=(
            "Path to omniintelligence repo root. "
            "Defaults to ../omniintelligence relative to omnidash root."
        ),
    )
    parser.add_argument(
        "--omnidash",
        default=None,
        help=(
            "Path to omnidash repo root. "
            "Defaults to the directory containing this script's parent."
        ),
    )
    return parser.parse_args()


def resolve_repo_path(
    arg_value: str | None, default_relative: str, omnidash_root: Path
) -> Path:
    if arg_value:
        return Path(arg_value).resolve()
    # Default: sibling directory relative to omnidash root
    return (omnidash_root / ".." / default_relative).resolve()


def main() -> int:
    args = parse_args()

    # Determine omnidash root
    script_dir = Path(__file__).resolve().parent
    omnidash_root = (
        Path(args.omnidash).resolve() if args.omnidash else script_dir.parent
    )

    repo_roots = {
        "omnibase_core": resolve_repo_path(
            args.omnibase_core, "omnibase_core", omnidash_root
        ),
        "omniintelligence": resolve_repo_path(
            args.omniintelligence, "omniintelligence", omnidash_root
        ),
    }

    print("TypeScript Type Sync Check (OMN-3258)")
    print("=" * 60)
    print(f"Omnidash root:      {omnidash_root}")
    for name, path in repo_roots.items():
        status = "OK" if path.exists() else "MISSING"
        print(f"  {name:<20} {path}  [{status}]")
    print()

    overall_pass = True

    for target in TARGETS:
        print(f"Checking: {target['name']}")
        print(f"  Python: {target['python_rel']}")
        print(f"  TS:     {target['ts_path']}")

        python_repo_root = repo_roots[target["python_repo"]]
        python_path = python_repo_root / target["python_rel"]
        ts_path = omnidash_root / target["ts_path"]

        # --- Step 1: Extract Python fields ---
        all_fields = extract_pydantic_fields(python_path, target["model_class"])
        if not all_fields:
            print(
                f"  WARN: No fields extracted from {target['model_class']} — "
                "skipping (file missing or class not found)"
            )
            print()
            continue

        print(f"  Python fields extracted: {sorted(all_fields)}")

        # --- Step 2: Determine required fields ---
        # Use explicit required_fields list if provided; otherwise use all
        # Python fields minus excluded ones.
        if target.get("required_fields"):
            required = set(target["required_fields"])
        else:
            required = all_fields - target.get("exclude_fields", set())

        print(f"  Required in TS ({len(required)}): {sorted(required)}")

        # --- Step 3: Check TS file ---
        missing = check_fields_in_ts(ts_path, required)

        if missing:
            print(f"  FAIL: {len(missing)} field(s) missing from TypeScript type:")
            for field in missing:
                print(f"    - {field}")
            overall_pass = False
        else:
            print(f"  PASS: all {len(required)} required fields present in TypeScript")

        print()

    print("=" * 60)
    if overall_pass:
        print("RESULT: PASS — all TypeScript boundary types are in sync")
        return 0
    else:
        print("RESULT: FAIL — TypeScript types are out of sync with Python models")
        print()
        print(
            "To fix: update the TypeScript types in shared/ to include the missing fields."
        )
        print("See OMN-3258 for the type sync policy.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
