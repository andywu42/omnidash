#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OmniNode.ai Inc.
# SPDX-License-Identifier: MIT
#
# OMN-3258: TypeScript Type Sync Check (shell wrapper)
#
# Verifies that TypeScript boundary types in omnidash/shared/ stay in sync
# with the corresponding Python Pydantic models in omnibase_core and
# omniintelligence.
#
# Usage:
#   scripts/check-type-sync.sh [--omnibase-core PATH] [--omniintelligence PATH]
#
# Environment variables (override paths):
#   OMNIBASE_CORE_PATH       — path to omnibase_core repo root
#   OMNIINTELLIGENCE_PATH    — path to omniintelligence repo root
#
# In CI this script is invoked after the Python repos are checked out as
# sibling directories alongside omnidash.
#
# Exit codes:
#   0 — all TypeScript boundary types are in sync with Python models
#   1 — one or more TypeScript types are missing Python model fields
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OMNIDASH_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Allow overriding via env vars or CLI args
OMNIBASE_CORE_ARG=""
OMNIINTELLIGENCE_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --omnibase-core)
      OMNIBASE_CORE_ARG="--omnibase-core $2"
      shift 2
      ;;
    --omniintelligence)
      OMNIINTELLIGENCE_ARG="--omniintelligence $2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Override from env vars if not set via CLI args
if [[ -z "$OMNIBASE_CORE_ARG" && -n "${OMNIBASE_CORE_PATH:-}" ]]; then
  OMNIBASE_CORE_ARG="--omnibase-core $OMNIBASE_CORE_PATH"
fi
if [[ -z "$OMNIINTELLIGENCE_ARG" && -n "${OMNIINTELLIGENCE_PATH:-}" ]]; then
  OMNIINTELLIGENCE_ARG="--omniintelligence $OMNIINTELLIGENCE_PATH"
fi

echo "Running TypeScript type sync check..."
echo ""

# Run the Python check script.
# Uses python3 directly (stdlib ast only — no uv or additional packages needed).
# shellcheck disable=SC2086
python3 "$OMNIDASH_ROOT/scripts/check_type_sync.py" \
  --omnidash "$OMNIDASH_ROOT" \
  $OMNIBASE_CORE_ARG \
  $OMNIINTELLIGENCE_ARG
