# AGENT.md -- omnidash

> LLM navigation guide. Points to context sources -- does not duplicate them.

## Context

- **Architecture overview**: `docs/architecture/OVERVIEW.md`
- **Route catalog**: `docs/architecture/ROUTE_CATALOG.md`
- **Event mapping**: `docs/EVENT_TO_COMPONENT_MAPPING.md`
- **Full index**: `docs/INDEX.md`
- **Conventions**: `CLAUDE.md`

## Commands

- Dev server: `PORT=3000 npm run dev`
- Tests: `npm test`
- Lint: `npm run lint`
- Build: `npm run build`

## Cross-Repo

- Shared platform standards: `~/.claude/CLAUDE.md`
- Kafka topics: `omnibase_infra/CLAUDE.md`

## Rules

- React 18 + Vite + Express + TypeScript + TailwindCSS
- All data from Kafka projections into omnidash_analytics DB
- No direct API calls to omnibase_infra services from frontend
