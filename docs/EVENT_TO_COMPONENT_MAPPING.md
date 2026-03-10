# Event Catalog to Dashboard Component Mapping

**Purpose**: Map event bus events to dashboard data sources and identify gaps

**Date**: November 2025

**Status**: Analysis Document

---

## Overview

This document maps:

1. **Event Catalog Events** → **Data Sources** → **UI Components**
2. **Missing Events**: Data sources that need events but don't have them
3. **Missing Data Sources**: Events that exist but don't have data sources yet
4. **Missing Components**: Events/data that could be displayed but aren't yet

---

## Current Data Sources

### 1. Intelligence Analytics Source (`intelligence-analytics-source.ts`)

**Current Data Provided**:

- `fetchMetrics()` → IntelligenceMetrics (totalQueries, avgResponseTime, successRate, fallbackRate, costPerQuery, totalCost, qualityScore, userSatisfaction)
- `fetchRecentActivity()` → RecentActivity[] (action, agent, time, status, timestamp)
- `fetchAgentPerformance()` → AgentPerformance[] (agentId, agentName, totalRuns, avgResponseTime, successRate, efficiency, avgQualityScore, popularity, costPerSuccess, p95Latency, lastUsed)
- `fetchSavingsMetrics()` → SavingsMetrics (totalSavings, monthlySavings, weeklySavings, dailySavings, intelligenceRuns, baselineRuns, avgTokensPerRun, avgComputePerRun, costPerToken, costPerCompute, efficiencyGain, timeSaved)

**Maps to Events**:

- ✅ `omninode.intelligence.query.completed.v1` → totalQueries, avgResponseTime, successRate
- ✅ `omninode.intelligence.query.failed.v1` → fallbackRate
- ✅ `omninode.agent.execution.completed.v1` → agent performance metrics
- ✅ `omninode.agent.execution.failed.v1` → agent performance metrics
- ✅ `omninode.agent.provider.selected.v1` → costPerQuery, totalCost
- ✅ `omninode.agent.confidence.scored.v1` → qualityScore, userSatisfaction
- ✅ `omninode.intelligence.query.requested.v1` → RecentActivity
- ✅ `omninode.agent.execution.started.v1` → RecentActivity
- ✅ `omninode.agent.execution.completed.v1` → RecentActivity
- ✅ `omninode.agent.execution.failed.v1` → RecentActivity

**Missing Events** (events exist but not consumed):

- ❌ `omninode.intelligence.search.completed.v1` → Could add search metrics
- ❌ `omninode.intelligence.quality.assessed.v1` → Could enhance qualityScore
- ❌ `omninode.intelligence.performance.analyzed.v1` → Could add performance analysis
- ❌ `omninode.intelligence.freshness.checked.v1` → Could add freshness metrics

**Component**: `IntelligenceAnalytics.tsx`

---

### 2. Agent Operations Source (`agent-operations-source.ts`)

**Current Data Provided**:

- `fetchSummary()` → AgentSummary (totalAgents, activeAgents, totalRuns, successRate, avgExecutionTime)
- `fetchRecentActions()` → RecentAction[] (id, agentId, agentName, action, status, timestamp, duration)
- `fetchHealth()` → HealthStatus (status, services[])
- `transformOperationsForChart()` → ChartDataPoint[] (time, value)
- `transformQualityForChart()` → ChartDataPoint[] (time, value)
- `transformOperationsStatus()` → OperationStatus[] (id, name, status, count, avgTime)

**Maps to Events**:

- ✅ `omninode.agent.execution.started.v1` → totalRuns, activeAgents
- ✅ `omninode.agent.execution.completed.v1` → successRate, avgExecutionTime, RecentActions
- ✅ `omninode.agent.execution.failed.v1` → successRate, RecentActions
- ✅ `omninode.agent.routing.completed.v1` → routing stats
- ✅ `omninode.service.health.changed.v1` → HealthStatus

**Missing Events**:

- ❌ `omninode.agent.routing.requested.v1` → Could add routing request metrics
- ❌ `omninode.agent.routing.failed.v1` → Could add routing failure metrics
- ❌ `omninode.agent.quality.gate.passed.v1` → Could add quality gate metrics
- ❌ `omninode.agent.quality.gate.failed.v1` → Could add quality gate failure metrics

**Component**: `AgentOperations.tsx` (via AgentManagement)

---

### 3. Agent Management Source (`agent-management-source.ts`)

**Current Data Provided**:

- `fetchSummary()` → AgentSummary (totalAgents, activeAgents, totalRuns, successRate, avgExecutionTime)
- `fetchRoutingStats()` → RoutingStats (totalDecisions, avgConfidence, topAgents, routingDistribution)
- `fetchRecentExecutions()` → AgentExecution[] (id, agentId, agentName, query, status, timestamp, duration, tokensUsed, cost)
- `fetchRecentDecisions()` → RoutingDecision[] (id, query, selectedAgent, confidence, timestamp, reasoning, alternatives)

**Maps to Events**:

- ✅ `omninode.agent.routing.completed.v1` → RoutingStats, RoutingDecision
- ✅ `omninode.agent.execution.completed.v1` → AgentExecution
- ✅ `omninode.agent.execution.started.v1` → AgentExecution
- ✅ `omninode.agent.confidence.scored.v1` → RoutingStats (avgConfidence)

**Missing Events**:

- ❌ `omninode.agent.routing.requested.v1` → Could track routing requests
- ❌ `omninode.agent.routing.failed.v1` → Could track routing failures
- ❌ `omninode.agent.quality.gate.passed.v1` → Could add quality gate info to executions
- ❌ `omninode.agent.quality.gate.failed.v1` → Could add quality gate failures

**Component**: `AgentManagement.tsx`

---

### 4. Code Intelligence Source (`code-intelligence-source.ts`)

**Current Data Provided**:

- `fetchCodeAnalysis()` → CodeAnalysisData (files_analyzed, avg_complexity, code_smells, security_issues, complexity_trend, quality_trend)
- `fetchCompliance()` → ComplianceData (summary, statusBreakdown, nodeTypeBreakdown, trend)
- `fetchPatternSummary()` → PatternSummaryCodeIntel (totalPatterns, activePatterns, qualityScore, usageCount, recentDiscoveries, topPatterns)

**Maps to Events**:

- ✅ `omninode.intelligence.quality.assessed.v1` → CodeAnalysisData (avg_complexity, code_smells, quality_trend)
- ✅ `omninode.intelligence.compliance.validated.v1` → ComplianceData
- ✅ `omninode.intelligence.pattern.discovered.v1` → PatternSummaryCodeIntel
- ✅ `omninode.intelligence.performance.analyzed.v1` → Could enhance CodeAnalysisData

**Missing Events**:

- ❌ `omninode.intelligence.quality.requested.v1` → Could track quality assessment requests
- ❌ `omninode.intelligence.compliance.requested.v1` → Could track compliance validation requests
- ❌ `omninode.intelligence.pattern.matched.v1` → Could add pattern matching metrics
- ❌ `omninode.code.generation.completed.v1` → Could link code generation to analysis
- ❌ `omninode.code.validation.completed.v1` → Could add validation results

**Component**: `CodeIntelligenceSuite.tsx`

---

### 5. Pattern Learning Source (`pattern-learning-source.ts`)

**Current Data Provided**:

- `fetchSummary()` → PatternSummary (totalPatterns, newPatternsToday, avgQualityScore, activeLearningCount)
- `fetchTrends()` → PatternTrend[] (period, manifestsGenerated, avgPatternsPerManifest, avgQueryTimeMs)
- `fetchQualityTrends()` → QualityTrend[] (period, avgQuality, manifestCount)
- `fetchLanguageBreakdown()` → LanguageBreakdown[] (language, count, percentage)
- `fetchPatterns()` → Pattern[] (id, name, description, quality, usage, trend, trendPercentage, category, language)

**Maps to Events**:

- ✅ `omninode.intelligence.pattern.discovered.v1` → PatternSummary, Pattern[]
- ✅ `omninode.intelligence.pattern.matched.v1` → Pattern[] (usage, trend)
- ✅ `omninode.code.generation.completed.v1` → PatternTrend (manifestsGenerated)

**Missing Events**:

- ❌ `omninode.intelligence.pattern.discovery.requested.v1` → Could track discovery requests
- ❌ `omninode.intelligence.pattern.discovery.completed.v1` → Could track discovery completion
- ❌ `omninode.pattern.contributed.v1` → Could add pattern contribution metrics (planned feature)
- ❌ `omninode.pattern.improved.v1` → Could add pattern improvement metrics (planned feature)
- ❌ `omninode.pattern.effectiveness.measured.v1` → Could add effectiveness metrics (planned feature)

**Component**: Pattern Learning Dashboard (not yet created, but data exists)

---

### 6. Platform Health Source (`platform-health-source.ts`)

**Current Data Provided**:

- `fetchHealth()` → PlatformHealth (status, uptime, services[])
- `fetchServices()` → PlatformServices (services[])

**Maps to Events**:

- ✅ `omninode.service.health.changed.v1` → PlatformHealth
- ✅ `omninode.service.registered.v1` → PlatformServices
- ✅ `omninode.service.deregistered.v1` → PlatformServices
- ✅ `omninode.database.connection.status.v1` → PlatformHealth (database service)
- ✅ `omninode.consul.service.health.changed.v1` → PlatformHealth
- ✅ `omninode.consul.service.registered.v1` → PlatformServices
- ✅ `omninode.consul.service.deregistered.v1` → PlatformServices

**Missing Events**:

- ❌ `omninode.database.connection.lost.v1` → Could add connection loss alerts
- ❌ `omninode.database.connection.restored.v1` → Could add connection restoration tracking
- ❌ `omninode.database.query.failed.v1` → Could add query failure metrics
- ❌ `omninode.kafka.topic.activity.v1` → Could add Kafka topic activity (exists but not consumed)
- ❌ `omninode.vault.secret.access.audited.v1` → Could add Vault audit tracking

**Component**: `SystemHealth.tsx`, `PlatformMonitoring.tsx`

---

### 7. Event Flow Source (`event-flow-source.ts`)

**Current Data Provided**:

- `fetchEvents()` → EventFlowData (events[], metrics, chartData)
- `calculateMetrics()` → EventMetrics (totalEvents, uniqueTypes, eventsPerMinute, avgProcessingTime, topicCounts)
- `generateChartData()` → EventChartData (throughput, lag)

**Maps to Events**:

- ✅ **ALL EVENTS** → EventFlowData (generic event stream)
- ✅ Event metadata → EventMetrics

**Missing Events**:

- ❌ No specific missing events (consumes all events generically)

**Component**: Event Flow Dashboard (not yet created, but data exists)

---

### 8. Agent Network Source (`agent-network-source.ts`)

**Current Data Provided**:

- `fetchAgents()` → Agent[] (id, name, type, status, capabilities, connections)
- `fetchRoutingDecisions()` → RoutingDecision[] (id, query, selectedAgent, confidence, timestamp, reasoning, alternatives)

**Maps to Events**:

- ✅ `omninode.agent.routing.completed.v1` → RoutingDecision
- ✅ `omninode.node.service.registered.v1` → Agent[] (via registry)
- ✅ `onex.node.announce.v1` → Agent[] (capabilities, tools)

**Missing Events**:

- ❌ `omninode.node.service.deregistered.v1` → Could track agent deregistration
- ❌ `onex.node.introspect_response.v1` → Could enhance agent capabilities
- ❌ `omninode.agent.execution.completed.v1` → Could add execution relationships to network graph

**Component**: `AgentNetwork.tsx`

---

### 9. Intelligence Savings Source (`intelligence-savings-source.ts`)

**Current Data Provided**:

- `fetchMetrics()` → SavingsMetrics (totalSavings, monthlySavings, weeklySavings, dailySavings, intelligenceRuns, baselineRuns, avgTokensPerRun, avgComputePerRun, costPerToken, costPerCompute, efficiencyGain, timeSaved)
- `fetchAgentComparisons()` → AgentComparison[] (agentId, agentName, withIntelligence, withoutIntelligence, savings)
- `fetchTimeSeries()` → TimeSeriesData[] (date, withIntelligence, withoutIntelligence, savings, dataAvailable)
- `fetchProviderSavings()` → ProviderSavings[] (providerId, providerName, savingsAmount, tokensProcessed, tokensOffloaded, percentageOfTotal, avgCostPerToken, runsCount)

**Maps to Events**:

- ✅ `omninode.agent.execution.completed.v1` → SavingsMetrics (tokensUsed, cost, duration)
- ✅ `omninode.agent.provider.selected.v1` → ProviderSavings

**Missing Events**:

- ❌ `omninode.token.consumed.v1` → Could add token consumption tracking (planned feature)
- ❌ `omninode.token.earned.v1` → Could add token earning tracking (planned feature)
- ❌ `omninode.token.balance.updated.v1` → Could add token balance tracking (planned feature)
- ❌ `omninode.token.usage.recorded.v1` → Could enhance usage metrics (planned feature)

**Component**: `IntelligenceSavings.tsx`

---

### 10. Knowledge Graph Source (`knowledge-graph-source.ts`)

**Current Data Provided**:

- `fetchGraph()` → KnowledgeGraphData (nodes[], edges[], isMock)

**Maps to Events**:

- ✅ `omninode.intelligence.pattern.discovered.v1` → nodes (patterns)
- ✅ `omninode.intelligence.pattern.matched.v1` → edges (pattern relationships)
- ✅ `omninode.metadata.stamping.stamped.v1` → nodes (artifacts)
- ✅ `omninode.code.generation.completed.v1` → nodes (generated code)

**Missing Events**:

- ❌ `omninode.metadata.tree.stamping.completed.v1` → Could add tree structure to graph
- ❌ `omninode.metadata.orphaned.detected.v1` → Could add orphaned artifact nodes
- ❌ `omninode.code.contract.generated.v1` → Could add contract nodes
- ❌ `omninode.code.tests.generated.v1` → Could add test nodes

**Component**: Knowledge Graph Dashboard (not yet created, but data exists)

---

### 11. Architecture Networks Source (`architecture-networks-source.ts`)

**Current Data Provided**:

- `fetchSummary()` → ArchitectureSummary (totalNodes, totalEdges, avgDegree, communities, centralNodes)

**Maps to Events**:

- ✅ `omninode.node.service.registered.v1` → nodes
- ✅ `omninode.service.registered.v1` → nodes
- ✅ `omninode.bridge.orchestration.completed.v1` → edges (workflow relationships)

**Missing Events**:

- ❌ `omninode.bridge.workflow.completed.v1` → Could add workflow relationships
- ❌ `omninode.bridge.orchestration.started.v1` → Could track orchestration starts
- ❌ `omninode.consul.service.discovered.v1` → Could add service discovery relationships

**Component**: `ArchitectureNetworks.tsx`

---

### 12. Agent Registry Source (`agent-registry-source.ts`)

**Current Data Provided**:

- `fetchAgents()` → Agent[] (id, name, type, status, capabilities, metadata)

**Maps to Events**:

- ✅ `omninode.node.service.registered.v1` → Agent[]
- ✅ `onex.node.announce.v1` → Agent[] (capabilities, tools)
- ✅ `onex.node.introspect_response.v1` → Agent[] (enhanced capabilities)

**Missing Events**:

- ❌ `omninode.node.service.deregistered.v1` → Could track deregistration
- ❌ `onex.registry.introspect_request.v1` → Could track registry requests

**Component**: `AgentRegistry.tsx`

---

### 13. Developer Tools Source (`developer-tools-source.ts`)

**Current Data Provided**:

- Various developer tool data (needs investigation)

**Maps to Events**:

- ❓ Needs investigation

**Component**: `DeveloperTools.tsx`

---

### 14. Platform Monitoring Source (`platform-monitoring-source.ts`)

**Current Data Provided**:

- Platform monitoring metrics (needs investigation)

**Maps to Events**:

- ✅ `omninode.service.health.changed.v1`
- ✅ `omninode.database.connection.status.v1`
- ✅ `omninode.consul.service.health.changed.v1`
- ✅ `omninode.kafka.topic.activity.v1`

**Component**: `PlatformMonitoring.tsx`

---

## Event Catalog Events NOT Yet Consumed

### Intelligence Domain

- ❌ `omninode.intelligence.search.requested.v1` → No data source
- ❌ `omninode.intelligence.search.completed.v1` → No data source
- ❌ `omninode.intelligence.search.failed.v1` → No data source
- ❌ `omninode.intelligence.quality.requested.v1` → No data source
- ❌ `omninode.intelligence.pattern.discovery.requested.v1` → No data source
- ❌ `omninode.intelligence.pattern.discovery.completed.v1` → No data source
- ❌ `omninode.intelligence.compliance.requested.v1` → No data source
- ❌ `omninode.intelligence.freshness.checked.v1` → No data source

### Agent Domain

- ❌ `omninode.agent.routing.requested.v1` → Partially consumed (could enhance)
- ❌ `omninode.agent.routing.failed.v1` → Not consumed
- ❌ `omninode.agent.quality.gate.passed.v1` → Not consumed
- ❌ `omninode.agent.quality.gate.failed.v1` → Not consumed

### Metadata Domain

- ❌ `omninode.metadata.stamping.requested.v1` → No data source
- ❌ `omninode.metadata.stamping.failed.v1` → No data source
- ❌ `omninode.metadata.tree.stamping.requested.v1` → No data source
- ❌ `omninode.metadata.tree.stamping.completed.v1` → No data source
- ❌ `omninode.metadata.tree.stamping.failed.v1` → No data source
- ❌ `omninode.metadata.orphaned.detected.v1` → No data source

### Code Generation Domain

- ❌ `omninode.code.generation.requested.v1` → No data source
- ❌ `omninode.code.generation.failed.v1` → No data source
- ❌ `omninode.code.contract.generated.v1` → No data source
- ❌ `omninode.code.tests.generated.v1` → No data source
- ❌ `omninode.code.validation.requested.v1` → No data source
- ❌ `omninode.code.validation.completed.v1` → No data source
- ❌ `omninode.code.validation.failed.v1` → No data source

### Database Domain

- ❌ `omninode.database.query.requested.v1` → No data source
- ❌ `omninode.database.query.completed.v1` → No data source
- ❌ `omninode.database.query.failed.v1` → No data source
- ❌ `omninode.database.transaction.requested.v1` → No data source
- ❌ `omninode.database.transaction.completed.v1` → No data source
- ❌ `omninode.database.transaction.failed.v1` → No data source
- ❌ `omninode.database.migration.requested.v1` → No data source
- ❌ `omninode.database.migration.completed.v1` → No data source
- ❌ `omninode.database.migration.failed.v1` → No data source
- ❌ `omninode.database.connection.lost.v1` → No data source
- ❌ `omninode.database.connection.restored.v1` → No data source

### Consul Domain

- ❌ `omninode.consul.service.register.requested.v1` → No data source
- ❌ `omninode.consul.service.registered.v1` → Partially consumed (via Platform Health)
- ❌ `omninode.consul.service.deregister.requested.v1` → No data source
- ❌ `omninode.consul.service.deregistered.v1` → Partially consumed (via Platform Health)
- ❌ `omninode.consul.service.discover.requested.v1` → No data source
- ❌ `omninode.consul.service.discovered.v1` → No data source
- ❌ `omninode.consul.health.check.requested.v1` → No data source
- ❌ `omninode.consul.health.status.v1` → No data source

### Vault Domain

- ❌ `omninode.vault.secret.read.requested.v1` → No data source
- ❌ `omninode.vault.secret.read.completed.v1` → No data source
- ❌ `omninode.vault.secret.read.failed.v1` → No data source
- ❌ `omninode.vault.secret.write.requested.v1` → No data source
- ❌ `omninode.vault.secret.write.completed.v1` → No data source
- ❌ `omninode.vault.secret.write.failed.v1` → No data source
- ❌ `omninode.vault.secret.rotate.requested.v1` → No data source
- ❌ `omninode.vault.secret.rotate.completed.v1` → No data source
- ❌ `omninode.vault.secret.rotate.failed.v1` → No data source
- ❌ `omninode.vault.secret.list.requested.v1` → No data source
- ❌ `omninode.vault.secret.list.completed.v1` → No data source
- ❌ `omninode.vault.secret.delete.requested.v1` → No data source
- ❌ `omninode.vault.secret.delete.completed.v1` → No data source
- ❌ `omninode.vault.secret.access.audited.v1` → No data source (but mentioned in Platform Health)

### Bridge Domain

- ❌ `omninode.bridge.orchestration.started.v1` → No data source
- ❌ `omninode.bridge.orchestration.completed.v1` → Partially consumed (via Architecture Networks)
- ❌ `omninode.bridge.orchestration.failed.v1` → No data source
- ❌ `omninode.bridge.workflow.started.v1` → No data source
- ❌ `omninode.bridge.workflow.completed.v1` → No data source
- ❌ `omninode.bridge.workflow.failed.v1` → No data source

### Logging Domain

- ❌ `omninode.logging.application.v1` → No data source
- ❌ `omninode.logging.audit.v1` → No data source
- ❌ `omninode.logging.security.v1` → No data source

### Registry/ONEX Domain

- ❌ `onex.registry.introspect_request.v1` → No data source
- ❌ `onex.node.introspect_response.v1` → Partially consumed (via Agent Registry)

---

## Summary: What's Missing

### High Priority (Core Functionality)

1. **Event Bus Data Source** (`event-bus-source.ts`)
   - **Purpose**: Subscribe to Kafka/Redpanda events and transform to data source format
   - **Events to Consume**: All events from catalog
   - **Transformations**: Event envelope → Data source format
   - **Storage**: PostgreSQL for historical queries
   - **Real-time**: WebSocket push to React frontend

2. **Database Operations Data Source** (`database-operations-source.ts`)
   - **Purpose**: Track database query/transaction/migration events
   - **Events**: `omninode.database.*` events
   - **Component**: Database Operations Dashboard (new)

3. **Vault Operations Data Source** (`vault-operations-source.ts`)
   - **Purpose**: Track secret access (audit trail, no secret values)
   - **Events**: `omninode.vault.*` events
   - **Component**: Vault Audit Dashboard (new)

4. **Consul Operations Data Source** (`consul-operations-source.ts`)
   - **Purpose**: Track service discovery operations
   - **Events**: `omninode.consul.*` events
   - **Component**: Service Discovery Dashboard (new)

5. **Code Generation Data Source** (`code-generation-source.ts`)
   - **Purpose**: Track code generation, contracts, tests, validation
   - **Events**: `omninode.code.*` events
   - **Component**: Code Generation Dashboard (new)

6. **Metadata Operations Data Source** (`metadata-operations-source.ts`)
   - **Purpose**: Track metadata stamping operations
   - **Events**: `omninode.metadata.*` events
   - **Component**: Metadata Dashboard (new)

7. **Bridge/Workflow Data Source** (`bridge-operations-source.ts`)
   - **Purpose**: Track orchestration and workflow events
   - **Events**: `omninode.bridge.*` events
   - **Component**: Workflow Dashboard (new)

8. **Logging Data Source** (`logging-source.ts`)
   - **Purpose**: Aggregate application, audit, and security logs
   - **Events**: `omninode.logging.*` events
   - **Component**: Logs Dashboard (new)

### Medium Priority (Enhancements)

1. **Enhanced Intelligence Analytics**
   - Consume `omninode.intelligence.search.*` events
   - Consume `omninode.intelligence.freshness.checked.v1`
   - Add search metrics to Intelligence Analytics dashboard

2. **Enhanced Agent Management**
   - Consume `omninode.agent.routing.failed.v1`
   - Consume `omninode.agent.quality.gate.*` events
   - Add quality gate metrics to Agent Management dashboard

3. **Enhanced Code Intelligence**
   - Consume `omninode.code.validation.*` events
   - Link code generation to analysis
   - Add validation results to Code Intelligence dashboard

### Low Priority (Planned Features)

1. **Token Economy Data Source** (when feature is implemented)
   - Events: `omninode.token.*`
   - Component: Token Economy Dashboard

2. **Pattern Distribution Data Source** (when feature is implemented)
   - Events: `omninode.pattern.*`
   - Component: Pattern Distribution Dashboard

3. **P2P Distribution Data Source** (when feature is implemented)
   - Events: `omninode.p2p.*`
   - Component: P2P Distribution Dashboard

4. **MetaContext Data Source** (when feature is implemented)
   - Events: `omninode.metacontext.*`
   - Component: MetaContext Dashboard

---

## Implementation Priority

### Phase 1: Event Bus Integration

1. Create `EventBusDataSource` class in omnidash backend
2. Subscribe to all events from Kafka/Redpanda
3. Transform events → PostgreSQL storage
4. Push events → WebSocket → React frontend

### Phase 2: Core Missing Data Sources

1. Database Operations Data Source
2. Vault Operations Data Source
3. Consul Operations Data Source
4. Code Generation Data Source
5. Metadata Operations Data Source

### Phase 3: Enhanced Existing Data Sources

1. Add missing events to Intelligence Analytics
2. Add missing events to Agent Management
3. Add missing events to Code Intelligence
4. Add missing events to Platform Health

### Phase 4: New Dashboards

1. Database Operations Dashboard
2. Vault Audit Dashboard
3. Service Discovery Dashboard
4. Code Generation Dashboard
5. Metadata Dashboard
6. Workflow Dashboard
7. Logs Dashboard

---

## Data Flow Architecture

```
Event Bus (Kafka/Redpanda)
    ↓
EventBusDataSource (Backend)
    ↓
    ├─→ PostgreSQL (Historical Storage)
    ├─→ WebSocket (Real-time Push)
    └─→ Data Source Transformers
            ↓
        UI Components
```

---

**Document Version**: 1.0.0
**Last Updated**: November 2025
**Status**: Analysis Complete - Ready for Implementation
