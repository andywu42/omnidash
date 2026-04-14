# Pattern Intelligence Taxonomy

**Status**: Active  
**Ticket**: OMN-8707  
**Updated**: 2026-04-13

## Purpose

This document defines the canonical allowlist of pattern types that may be written into
`pattern_learning_artifacts`. Any pattern type not in the allowlist is rejected at
ingestion by the read-model consumer. This inverts the OMN-8710 denylist approach so
that new emitters cannot introduce noise types without explicit approval.

---

## Allowlist

### `tool_usage_pattern`

| Field | Value |
|---|---|
| **What it captures** | Sequences of tool calls within a session — which tools appear together, in what order, and how often. |
| **How it's emitted** | `NodePatternFeedbackEffect` in omniintelligence after a session completes and tool sequences are extracted. |
| **Example payload** | `{ "pattern_type": "tool_usage_pattern", "pattern_signature": "tool_sequence_pattern::Read,Edit: common editing flow", "composite_score": 0.50 }` |
| **Why it's actionable** | Identifies repeated multi-tool workflows (e.g. Read→Edit→Bash) that can be pre-warmed in context injections to reduce latency. |

---

### `architecture_pattern`

| Field | Value |
|---|---|
| **What it captures** | Structural layer patterns in the codebase — which layers import which, layering violations, and stable architectural shapes. Sub-types include `layer_pattern`. |
| **How it's emitted** | AST-extraction pipeline (`NodeAstExtractionCompute`) writing to pattern store after static analysis of import graphs. |
| **Example payload** | `{ "pattern_type": "architecture_pattern", "pattern_signature": "architecture_pattern::layer_pattern: server→shared→client", "composite_score": 0.50 }` |
| **Why it's actionable** | Layer violations surface as pre-commit failures; stable layer shapes inform context injection ordering. |

---

### `entry_point_pattern`

| Field | Value |
|---|---|
| **What it captures** | Files that are entry points for execution (main modules, CLI entrypoints, server bootstrap files) identified via AST analysis. |
| **How it's emitted** | AST-extraction pipeline after scanning for `if __name__ == "__main__"`, `app.listen()`, and similar bootstrapping idioms. |
| **Example payload** | `{ "pattern_type": "entry_point_pattern", "pattern_signature": "entry_point_pattern::server_bootstrap: server/index.ts", "composite_score": 0.50 }` |
| **Why it's actionable** | Entry points anchor context injection — knowing them prevents irrelevant files from polluting session context. |

---

### `function_signature`

| Field | Value |
|---|---|
| **What it captures** | AST-derived function name + argument types + return type, normalized to a canonical form. |
| **How it's emitted** | AST-extraction pipeline when function definitions are parsed across the codebase. |
| **Example payload** | `{ "pattern_type": "function_signature", "pattern_signature": "function_signature::projectPatternProjectionEvent: (data, fallbackId, context) -> Promise<boolean>", "composite_score": 0.60 }` |
| **Why it's actionable** | Enables cross-session function lookup, duplicate detection, and call-graph construction without LLM inference. |

---

### `class_definition`

| Field | Value |
|---|---|
| **What it captures** | AST-derived class name + base classes + public method signatures. |
| **How it's emitted** | AST-extraction pipeline when class definitions are parsed. |
| **Example payload** | `{ "pattern_type": "class_definition", "pattern_signature": "class_definition::OmniintelligenceProjectionHandler: extends ProjectionHandler", "composite_score": 0.55 }` |
| **Why it's actionable** | Enables structural search and interface compliance checking without re-reading files. |

---

### `import_pattern`

| Field | Value |
|---|---|
| **What it captures** | Which module imports which — directed import edges used for cycle detection and coupling analysis. |
| **How it's emitted** | AST-extraction pipeline after building import graphs. |
| **Example payload** | `{ "pattern_type": "import_pattern", "pattern_signature": "import_pattern::circular_dep: omnibase_core → omnibase_spi → omnibase_core", "composite_score": 0.80 }` |
| **Why it's actionable** | Circular imports cause runtime failures; high-coupling edges flag refactoring targets. |

---

### `bug_repetition`

| Field | Value |
|---|---|
| **What it captures** | The same bug fix applied to N similar files or contexts — identified when the same diff shape appears in multiple commits. |
| **How it's emitted** | Manual flag via `PatternLearningRequested` command with `pattern_type: bug_repetition`, or heuristically by the session analysis node when identical fix patterns repeat across sessions. |
| **Example payload** | `{ "pattern_type": "bug_repetition", "pattern_signature": "bug_repetition::null_check_missing: 3 files fixed in OMN-8694, OMN-8705, OMN-8706", "composite_score": 0.75 }` |
| **Why it's actionable** | High-recurrence bugs justify automated linting rules or template fixes that can be injected before the mistake is made. |

---

### `contract_violation`

| Field | Value |
|---|---|
| **What it captures** | A runtime check failed against `contract.yaml` expectations — e.g. handler registered without matching topic, or event emitted without declared output port. |
| **How it's emitted** | `NodeContractValidationCompute` or the contract compliance sweep when it detects drift. |
| **Example payload** | `{ "pattern_type": "contract_violation", "pattern_signature": "contract_violation::undeclared_topic: omniintelligence emits onex.evt.foo.bar.v1 not in contract.yaml", "composite_score": 0.90 }` |
| **Why it's actionable** | Contract violations cause invisible wiring failures at runtime. High-score violations should block merge. |

---

### `test_gap`

| Field | Value |
|---|---|
| **What it captures** | A function or module with no test coverage, identified by comparing coverage reports against the function list. |
| **How it's emitted** | Coverage sweep (`onex:coverage_sweep`) writing detected gaps into the pattern store. |
| **Example payload** | `{ "pattern_type": "test_gap", "pattern_signature": "test_gap::uncovered_function: omnibase_core/src/protocols/data_source.py:ProtocolDataSource.validate", "composite_score": 0.65 }` |
| **Why it's actionable** | Test gaps are prioritized tech-debt targets — actionable as ticket creation candidates. |

---

### `anti_pattern`

| Field | Value |
|---|---|
| **What it captures** | A known anti-pattern detected in code — e.g. hardcoded topic strings, `ANTHROPIC_API_KEY` required checks, direct `docker compose` calls. |
| **How it's emitted** | Pre-commit hooks or the `onex:aislop_sweep` skill when scanning for known bad patterns. |
| **Example payload** | `{ "pattern_type": "anti_pattern", "pattern_signature": "anti_pattern::hardcoded_topic: omniintelligence/handlers/foo.py line 42 hardcodes topic string", "composite_score": 0.85 }` |
| **Why it's actionable** | Anti-patterns are immediate fix targets; high-frequency ones justify pre-commit hooks. |

---

### `circular_dep`

| Field | Value |
|---|---|
| **What it captures** | A detected import cycle from the AST import graph — module A imports B which imports A (directly or transitively). |
| **How it's emitted** | AST-extraction pipeline or `graphify` audit when building the import graph and detecting cycles. |
| **Example payload** | `{ "pattern_type": "circular_dep", "pattern_signature": "circular_dep::transitive: omnibase_core.models → omnibase_spi.protocols → omnibase_core.models", "composite_score": 0.95 }` |
| **Why it's actionable** | Circular dependencies cause import failures and prevent clean modular separation; always a bug. |

---

## Denylist (historical noise — never re-introduce)

| Pattern type | Why rejected |
|---|---|
| `file_access_pattern` | Co-access pairs (which files were read together) — infrastructure noise with no actionable signal |
| `architecture_pattern::module_boundary` | Boundary declarations extracted from every file — 67 rows purged in OMN-8710; zero analytical value |
| `pipeline_request` | Request lifecycle traces — 404 rows, avg composite_score=0.00, last seen 2026-04-10; infrastructure telemetry not pattern intelligence |
| Any type matching `_co_` | Co-occurrence patterns — statistical correlation, not causal or actionable |
| Any type matching `module_boundary` | Module boundary declarations — see above |
| Any type matching `proximity` | Proximity/colocation patterns — high noise, zero fix surface |
| Any type matching `colocation` | Same as proximity |
| `learned_pattern` (fallback default) | Generic fallback assigned when type is unknown — use a specific allowlist type |

---

## Approval Process

To add a new pattern type to the allowlist:

1. **Write a proposal** in a Linear ticket with:
   - The `pattern_type` string value
   - Which handler/node emits it
   - A concrete example payload
   - A clear statement of what action a developer or agent should take when this pattern is observed

2. **Actionability test**: If you cannot answer "when I see this pattern, I will do X", the type is not actionable and should not be added.

3. **Update this file** — add a new entry to the Allowlist section with all six fields populated.

4. **Update the ingestion filter** — add the new type to `ALLOWED_PATTERN_TYPES` in
   `server/consumers/read-model/omniintelligence-projections.ts`.

5. **PR requirement**: The PR must include both the taxonomy doc update and the code change. Taxonomy-only or code-only PRs will be rejected.

---

## Filter Implementation

The allowlist is enforced at ingestion time in `projectPatternProjectionEvent()` via
`ALLOWED_PATTERN_TYPES`. Any event carrying a `pattern_type` not in this set is silently
dropped (watermark advances, no retry). This is intentional — unknown types are noise until
proven otherwise.

The `_isNoisePatternType()` denylist sub-filter (OMN-8710) remains active for defense-in-depth:
even if a type were added to the allowlist by mistake, the substring denylist catches known
noise signatures.
