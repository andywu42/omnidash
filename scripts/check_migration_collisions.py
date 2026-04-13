#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2025 OmniNode.ai Inc.
# SPDX-License-Identifier: MIT
"""Pre-commit + CI migration collision check for omnidash.

Scans migrations/ for files sharing the same numeric prefix (e.g. two files
starting with 0003). Duplicates cause non-deterministic apply order and silent
data loss. Exits 1 if any collisions are found.

Used as both a pre-commit hook (pass_filenames=false, always_run) and a CI job
step (OMN-8623).
"""
from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path


MIGRATION_PREFIX_RE = re.compile(r"^(\d{4}[a-z]?)")


def main() -> int:
    repo_root = Path(__file__).parent.parent
    migrations_dir = repo_root / "migrations"

    if not migrations_dir.exists():
        print("check_migration_collisions: migrations/ not found — skipping")
        return 0

    by_prefix: dict[str, list[str]] = defaultdict(list)
    for f in sorted(migrations_dir.iterdir()):
        if not f.is_file():
            continue
        m = MIGRATION_PREFIX_RE.match(f.name)
        if m:
            # Use the FULL prefix (digits + optional letter) as the dedup key.
            # 0003 vs 0003b → both map to different keys → no collision.
            # Two files both named 0034_* with no suffix → key "0034" → collision.
            # 0005a vs 0005b → keys "0005a" and "0005b" → no collision.
            by_prefix[m.group(1)].append(f.name)

    collisions = {prefix: files for prefix, files in by_prefix.items() if len(files) > 1}

    if collisions:
        print(f"migration-collision: {len(collisions)} duplicate prefix(es) detected:\n")
        for prefix, files in sorted(collisions.items()):
            print(f"  prefix {prefix}:")
            for fname in files:
                print(f"    {fname}")
        print("\nFAIL: rename one of the colliding files with a unique prefix before committing.")
        return 1

    total = sum(len(v) for v in by_prefix.values())
    print(f"migration-collision: {total} migration files, 0 collisions. PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
