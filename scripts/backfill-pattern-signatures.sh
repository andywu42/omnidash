#!/usr/bin/env bash
# Backfill pattern_learning_artifacts with actual pattern signatures from omniintelligence.
#
# PostgreSQL doesn't support cross-database queries natively, so this script:
# 1. Exports id + pattern_signature from omniintelligence.learned_patterns to a temp CSV
# 2. Imports the CSV into a temp table in omnidash_analytics
# 3. Updates pattern_learning_artifacts with the real signature data
#
# Usage:
#   source ~/.omnibase/.env
#   bash scripts/backfill-pattern-signatures.sh

set -euo pipefail

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set (source ~/.omnibase/.env)}"

PGHOST="${PGHOST:?PGHOST required}"
PGPORT="${PGPORT:-5436}"
PGUSER="${PGUSER:-postgres}"
TMPFILE="$(mktemp /tmp/pattern-signatures.XXXXXX.csv)"

trap 'rm -f "$TMPFILE"' EXIT

echo "Step 1: Exporting pattern signatures from omniintelligence..."
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d omniintelligence \
  -c "\\COPY (SELECT id::text, pattern_signature, domain_id FROM learned_patterns WHERE is_current = true) TO '$TMPFILE' WITH CSV HEADER"

ROW_COUNT=$(tail -n +2 "$TMPFILE" | wc -l | tr -d ' ')
echo "  Exported $ROW_COUNT patterns."

if [ "$ROW_COUNT" -eq 0 ]; then
  echo "Nothing to backfill."
  exit 0
fi

echo "Step 2: Importing into omnidash_analytics and updating..."
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d omnidash_analytics \
  -c "CREATE TEMP TABLE _backfill_sigs (source_id text, pattern_signature text, domain_id text);" \
  -c "\\COPY _backfill_sigs FROM '$TMPFILE' WITH CSV HEADER" \
  -c "
UPDATE pattern_learning_artifacts pla
SET
  pattern_name = b.pattern_signature,
  pattern_type = CASE
    WHEN b.pattern_signature LIKE '%::%' THEN split_part(b.pattern_signature, '::', 1)
    ELSE pla.pattern_type
  END,
  signature = pla.signature || jsonb_build_object('pattern_signature', b.pattern_signature),
  updated_at = NOW()
FROM _backfill_sigs b
WHERE pla.pattern_id = b.source_id::uuid;
" \
  -c "SELECT COUNT(*) AS updated_rows FROM pattern_learning_artifacts WHERE signature ? 'pattern_signature';"

echo "Backfill complete."
