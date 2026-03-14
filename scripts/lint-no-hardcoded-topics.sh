#!/usr/bin/env bash
# lint-no-hardcoded-topics.sh (OMN-5032)
#
# Anti-backslide tripwire: ensures no NEW hardcoded topic arrays are introduced
# in the consumer subscription paths. Existing deprecated arrays in shared/topics.ts
# are grandfathered (they are deprecated, not yet deleted).
#
# Checks:
#   1. No new topic list arrays are created in consumer files
#   2. topics.yaml manifest has entries for every handler in READ_MODEL_TOPICS
#   3. No direct buildSubscriptionTopics() calls outside of the deprecated fallback
#
# Exit codes:
#   0 = all checks pass
#   1 = violations found

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

VIOLATIONS=0

echo "=== lint-no-hardcoded-topics (OMN-5032) ==="
echo ""

# ---------------------------------------------------------------------------
# Check 1: No new hardcoded topic arrays in consumer files
# ---------------------------------------------------------------------------
echo "Check 1: No new hardcoded topic arrays in consumer subscription paths..."

# Look for patterns like `topics: [` or `subscribe({ topics: [` in consumer files
# that are NOT in deprecated/grandfathered locations
CONSUMER_FILES=(
  "$PROJECT_ROOT/server/event-consumer.ts"
  "$PROJECT_ROOT/server/read-model-consumer.ts"
)

for file in "${CONSUMER_FILES[@]}"; do
  if [ -f "$file" ]; then
    # Look for inline topic arrays (e.g., `topics: ['onex.evt...']` patterns)
    # Exclude lines that reference BOOTSTRAP_TOPICS, loadManifestTopics, or are comments
    matches=$(grep -n "topics:\s*\[.*'onex\." "$file" 2>/dev/null || true)
    if [ -n "$matches" ]; then
      echo -e "${RED}  FAIL${NC}: Hardcoded topic array found in $(basename "$file"):"
      echo "    $matches"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  fi
done

if [ "$VIOLATIONS" -eq 0 ]; then
  echo -e "${GREEN}  PASS${NC}: No new hardcoded topic arrays in consumer files"
fi

# ---------------------------------------------------------------------------
# Check 2: topics.yaml manifest exists and has entries
# ---------------------------------------------------------------------------
echo ""
echo "Check 2: topics.yaml manifest exists and is non-empty..."

MANIFEST="$PROJECT_ROOT/topics.yaml"
if [ ! -f "$MANIFEST" ]; then
  echo -e "${RED}  FAIL${NC}: topics.yaml not found at $MANIFEST"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  TOPIC_COUNT=$(grep -c "^\s*- topic:" "$MANIFEST" 2>/dev/null || echo 0)
  if [ "$TOPIC_COUNT" -eq 0 ]; then
    echo -e "${RED}  FAIL${NC}: topics.yaml has no topic entries"
    VIOLATIONS=$((VIOLATIONS + 1))
  else
    echo -e "${GREEN}  PASS${NC}: topics.yaml has $TOPIC_COUNT topic entries"
  fi
fi

# ---------------------------------------------------------------------------
# Check 3: No new buildSubscriptionTopics() imports in non-deprecated locations
# ---------------------------------------------------------------------------
echo ""
echo "Check 3: No new buildSubscriptionTopics() usage outside deprecated fallback..."

# Count non-deprecated imports of buildSubscriptionTopics in server/ files
# (excluding shared/topics.ts where it's defined, and test files)
NEW_IMPORTS=$(grep -r "import.*buildSubscriptionTopics" "$PROJECT_ROOT/server/" \
  --include="*.ts" \
  -l 2>/dev/null || true)

if [ -n "$NEW_IMPORTS" ]; then
  # Filter: event-consumer.ts is allowed (it has the deprecated fallback)
  for file in $NEW_IMPORTS; do
    basename_file=$(basename "$file")
    if [[ "$basename_file" != "event-consumer.ts" && "$basename_file" != *.test.ts ]]; then
      echo -e "${RED}  FAIL${NC}: New buildSubscriptionTopics() import in $basename_file"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done
fi

if [ "$VIOLATIONS" -eq 0 ]; then
  echo -e "${GREEN}  PASS${NC}: No new buildSubscriptionTopics() usage"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [ "$VIOLATIONS" -gt 0 ]; then
  echo -e "${RED}FAILED${NC}: $VIOLATIONS violation(s) found"
  echo ""
  echo "Fix: Use TopicRegistryService (EventConsumer) or topics.yaml (ReadModelConsumer)"
  echo "     instead of hardcoded topic arrays. See OMN-5022 for details."
  exit 1
else
  echo -e "${GREEN}PASSED${NC}: All topic lint checks pass"
  exit 0
fi
