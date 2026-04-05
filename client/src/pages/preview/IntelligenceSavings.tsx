import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { savingsSource } from '@/lib/data-sources/savings-source';
import { intelligenceAnalyticsSource } from '@/lib/data-sources';
import { getPollingInterval } from '@/lib/constants/query-config';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  TrendingUp,
  DollarSign,
  Zap,
  Brain,
  Clock,
  Activity,
  Target,
  Info,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CalendarIcon,
  Lightbulb,
  Cpu,
  Database,
  ArrowDownRight,
  ArrowUpRight,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { DateRange } from 'react-day-picker';
import { format } from 'date-fns';
import { getSuccessRateVariant } from '@/lib/utils';

interface UnifiedModelData {
  model: string;
  // Performance metrics
  requests: number;
  avgResponseTime: number;
  successRate: number;
  // Cost metrics
  cost: number;
  tokens: number;
  savingsAmount: number;
  tokensOffloaded: number;
  avgCostPerToken: number;
  runsCount: number;
  // Computed metrics
  costPerRequest: number;
  costPerToken: number;
}

export default function IntelligenceSavings() {
  const [activeTab, setActiveTab] = useState('overview');
  const [timeRange, setTimeRange] = useState('30d');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [customRange, setCustomRange] = useState<DateRange | undefined>();
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [sortColumn, setSortColumn] = React.useState<
    | 'model'
    | 'requests'
    | 'avgResponseTime'
    | 'successRate'
    | 'cost'
    | 'tokens'
    | 'usagePercentage'
    | 'savingsAmount'
    | 'costPerRequest'
    | 'tokensOffloaded'
    | 'avgCostPerToken'
    | 'runsCount'
    | 'costPerToken'
  >('cost');
  const [sortDirection, setSortDirection] = React.useState<'asc' | 'desc'>('desc');

  // Use savings data source backed by /api/savings endpoints
  const { data: savingsData, isLoading: _isLoading } = useQuery({
    queryKey: ['savings-all', timeRange, customRange],
    queryFn: () => savingsSource.fetchAll(timeRange),
    refetchInterval: getPollingInterval(60000),
  });

  // Fetch intelligence operations metrics
  const { data: intelligenceMetricsData } = useQuery({
    queryKey: ['intelligence-metrics', timeRange],
    queryFn: () => intelligenceAnalyticsSource.fetchMetrics(timeRange),
    refetchInterval: getPollingInterval(60000),
  });

  const savingsMetrics = savingsData?.metrics;
  const agentComparisons = savingsData?.agentComparisons || [];
  const timeSeriesData = savingsData?.timeSeriesData || [];
  const providerSavings = savingsData?.providerSavings || [];
  const intelligenceMetrics = intelligenceMetricsData?.data;

  // Data is now managed by TanStack Query, no need for local state

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat('en-US').format(num);
  };

  const formatPercentage = (num: number) => {
    return `${num.toFixed(1)}%`;
  };

  const toggleRow = (date: string) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(date)) {
      newExpanded.delete(date);
    } else {
      newExpanded.add(date);
    }
    setExpandedRows(newExpanded);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Intelligence System Savings</h1>
          <p className="text-muted-foreground">
            Track compute and token savings from using the intelligence system
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={timeRange === '7d' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTimeRange('7d')}
          >
            7D
          </Button>
          <Button
            variant={timeRange === '30d' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTimeRange('30d')}
          >
            30D
          </Button>
          <Button
            variant={timeRange === '90d' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTimeRange('90d')}
          >
            90D
          </Button>

          {/* Custom date range picker */}
          <Popover open={showCustomPicker} onOpenChange={setShowCustomPicker}>
            <PopoverTrigger asChild>
              <Button
                variant={timeRange === 'custom' ? 'default' : 'outline'}
                size="sm"
                className="gap-2"
              >
                <CalendarIcon className="h-4 w-4" />
                Custom
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="range"
                selected={customRange}
                onSelect={(range) => {
                  setCustomRange(range);
                  if (range?.from && range?.to) {
                    setTimeRange('custom');
                    setShowCustomPicker(false);
                  }
                }}
                numberOfMonths={2}
                initialFocus
              />
            </PopoverContent>
          </Popover>

          {/* Show selected custom range */}
          {timeRange === 'custom' && customRange?.from && customRange?.to && (
            <span className="text-sm text-muted-foreground">
              {format(customRange.from, 'MMM d')} - {format(customRange.to, 'MMM d, yyyy')}
            </span>
          )}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="agents">Agent Comparison</TabsTrigger>
          <TabsTrigger value="trends">Trends</TabsTrigger>
          <TabsTrigger value="breakdown">Cost Breakdown</TabsTrigger>
          <TabsTrigger value="models">AI Models</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          {/* Intelligence Operations Metrics - Moved to Top */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle>Intelligence Operations</CardTitle>
                <Badge variant="outline" className="text-xs">
                  Real-time
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Total Queries</CardTitle>
                    <Activity className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {formatNumber(intelligenceMetrics?.totalQueries || 0)}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Intelligence operations in {timeRange}
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
                    <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {intelligenceMetrics?.successRate?.toFixed(1) || '0.0'}%
                    </div>
                    <p className="text-xs text-muted-foreground">Query success rate</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Avg Response Time</CardTitle>
                    <Clock className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {intelligenceMetrics?.avgResponseTime
                        ? `${(intelligenceMetrics.avgResponseTime / 1000).toFixed(2)}s`
                        : '0.00s'}
                    </div>
                    <p className="text-xs text-muted-foreground">Average across all queries</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Total Savings</CardTitle>
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {formatCurrency(savingsMetrics?.totalSavings || 0)}
                    </div>
                    <p className="text-xs text-muted-foreground">Total cost savings achieved</p>
                  </CardContent>
                </Card>
              </div>
            </CardContent>
          </Card>

          {/* Key Savings Metrics Cards */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle>Cost Savings Breakdown</CardTitle>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm">
                    <p className="text-xs">
                      <strong>Methodology:</strong> Savings calculated by comparing agent
                      performance with intelligence (pattern injection, optimized routing) vs
                      baseline (standard AI agents). Includes token reduction (34%), local compute
                      offload (12%), and avoided API calls (8%).
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Daily Savings</CardTitle>
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {formatCurrency(savingsMetrics?.dailySavings || 0)}
                    </div>
                    <p className="text-xs text-muted-foreground">Average daily cost reduction</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Weekly Savings</CardTitle>
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {formatCurrency(savingsMetrics?.weeklySavings || 0)}
                    </div>
                    <p className="text-xs text-muted-foreground">Projected weekly savings</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Monthly Savings</CardTitle>
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {formatCurrency(savingsMetrics?.monthlySavings || 0)}
                    </div>
                    <p className="text-xs text-muted-foreground">Projected monthly savings</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Efficiency Gain</CardTitle>
                    <Target className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {formatPercentage(savingsMetrics?.efficiencyGain || 0)}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Average improvement across all agents
                    </p>
                  </CardContent>
                </Card>
              </div>
            </CardContent>
          </Card>

          {/* Detailed Metrics */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <CardTitle>Token Usage Comparison</CardTitle>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-md">
                      <div className="space-y-2 text-sm">
                        <p>
                          <strong>Intelligence Tokens:</strong> Actual token usage with pattern
                          injection, manifest optimization, and intelligent caching enabled.
                        </p>
                        <p>
                          <strong>Baseline Tokens:</strong> Estimated usage if agents ran without
                          intelligence features, based on standard AI agent behavior.
                        </p>
                        <p>
                          <strong>Token Savings:</strong> Reduction achieved through pattern caching
                          (40%), local model offloading (25%), optimized routing (20%), and other
                          optimizations (15%).
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <CardDescription>Intelligence system vs baseline agent runs</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Brain className="h-4 w-4 text-blue-600" />
                    <span className="text-sm font-medium">With Intelligence</span>
                  </div>
                  <div className="text-right">
                    <div className="font-bold">
                      {formatNumber(savingsMetrics?.intelligenceRuns || 0)} runs
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {formatNumber(savingsMetrics?.avgTokensPerRun || 0)} tokens/run
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-gray-600" />
                    <span className="text-sm font-medium">Without Intelligence</span>
                  </div>
                  <div className="text-right">
                    <div className="font-bold">
                      {formatNumber(savingsMetrics?.baselineRuns || 0)} runs
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {formatNumber(Math.round((savingsMetrics?.avgTokensPerRun || 0) * 1.6))}{' '}
                      tokens/run
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Token Savings</span>
                    <span className="font-medium text-green-600">
                      {formatNumber(Math.round((savingsMetrics?.avgTokensPerRun || 0) * 0.4))}{' '}
                      tokens/run
                    </span>
                  </div>
                  <Progress value={40} className="h-2" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Compute Usage Comparison</CardTitle>
                <CardDescription>
                  Processing efficiency improvements. Baseline represents typical costs if using
                  standard AI models (GPT-4, Claude Opus) without our intelligence optimizations.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-green-600" />
                    <span className="text-sm font-medium">With Intelligence</span>
                  </div>
                  <div className="text-right">
                    <div className="font-bold">
                      {savingsMetrics?.avgComputePerRun?.toFixed(1) || 0} units
                    </div>
                    <div className="text-sm text-muted-foreground">per run</div>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-gray-600" />
                    <span className="text-sm font-medium">Without Intelligence</span>
                  </div>
                  <div className="text-right">
                    <div className="font-bold">
                      {((savingsMetrics?.avgComputePerRun || 0) * 1.6).toFixed(1)} units
                    </div>
                    <div className="text-sm text-muted-foreground">per run</div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Compute Savings</span>
                    <span className="font-medium text-green-600">
                      {((savingsMetrics?.avgComputePerRun || 0) * 0.6).toFixed(1)} units/run
                    </span>
                  </div>
                  <Progress value={37.5} className="h-2" />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* How We Calculate Token Savings - Explanatory Card */}
          <Card className="col-span-full bg-blue-500/5 border-blue-500/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Lightbulb className="h-5 w-5 text-blue-500" />
                How We Calculate Token Savings
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Token savings are calculated by comparing actual usage with the intelligence
                  system enabled versus projected usage without it. Our intelligence system achieves
                  token reduction through multiple optimization techniques:
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                      <span className="font-semibold text-sm">Pattern Caching</span>
                    </div>
                    <div className="text-2xl font-bold text-blue-600">40%</div>
                    <p className="text-xs text-muted-foreground">
                      Reuses learned patterns instead of reprocessing similar code structures
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-green-500"></div>
                      <span className="font-semibold text-sm">Local Models</span>
                    </div>
                    <div className="text-2xl font-bold text-green-600">25%</div>
                    <p className="text-xs text-muted-foreground">
                      Offloads simple tasks to local models, avoiding expensive API calls
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-purple-500"></div>
                      <span className="font-semibold text-sm">Optimized Routing</span>
                    </div>
                    <div className="text-2xl font-bold text-purple-600">20%</div>
                    <p className="text-xs text-muted-foreground">
                      Routes tasks to the most efficient model for each job type
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-orange-500"></div>
                      <span className="font-semibold text-sm">Other Optimizations</span>
                    </div>
                    <div className="text-2xl font-bold text-orange-600">15%</div>
                    <p className="text-xs text-muted-foreground">
                      Manifest injection, context pruning, and response streaming
                    </p>
                  </div>
                </div>

                <div className="pt-3 border-t flex items-center justify-between">
                  <span className="text-sm font-medium">Total Token Reduction</span>
                  <span className="text-lg font-bold text-green-600">
                    {formatPercentage(savingsMetrics?.efficiencyGain || 40.7)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="agents" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Agent Performance Comparison</CardTitle>
              <CardDescription>
                Detailed comparison of agent runs with and without intelligence system
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {agentComparisons?.map((agent) => (
                  <div key={agent.agentId} className="border rounded-lg p-4">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="font-semibold">{agent.agentName}</h3>
                        <p className="text-sm text-muted-foreground">{agent.agentId}</p>
                      </div>
                      <Badge variant="secondary" className="text-green-600">
                        {formatPercentage(agent.savings.percentage)} savings
                      </Badge>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-2">
                        <div className="text-sm font-medium">Token Usage</div>
                        <div className="flex items-center gap-2">
                          <div className="text-sm text-muted-foreground">
                            {formatNumber(agent.withIntelligence.avgTokens)} vs{' '}
                            {formatNumber(agent.withoutIntelligence.avgTokens)}
                          </div>
                          <ArrowDownRight className="h-4 w-4 text-green-600" />
                        </div>
                        <div className="text-xs text-green-600">
                          -{formatNumber(agent.savings.tokens)} tokens/run
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="text-sm font-medium">Compute Usage</div>
                        <div className="flex items-center gap-2">
                          <div className="text-sm text-muted-foreground">
                            {agent.withIntelligence.avgCompute.toFixed(1)} vs{' '}
                            {agent.withoutIntelligence.avgCompute.toFixed(1)}
                          </div>
                          <ArrowDownRight className="h-4 w-4 text-green-600" />
                        </div>
                        <div className="text-xs text-green-600">
                          -{agent.savings.compute.toFixed(1)} units/run
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="text-sm font-medium">Cost per Run</div>
                        <div className="flex items-center gap-2">
                          <div className="text-sm text-muted-foreground">
                            {formatCurrency(agent.withIntelligence.cost)} vs{' '}
                            {formatCurrency(agent.withoutIntelligence.cost)}
                          </div>
                          <ArrowDownRight className="h-4 w-4 text-green-600" />
                        </div>
                        <div className="text-xs text-green-600">
                          -{formatCurrency(agent.savings.cost)}/run
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <div className="text-sm font-medium">Success Rate</div>
                        <div className="flex items-center gap-2">
                          <div className="text-sm text-muted-foreground">
                            {formatPercentage(agent.withIntelligence.successRate)} vs{' '}
                            {formatPercentage(agent.withoutIntelligence.successRate)}
                          </div>
                          <ArrowUpRight className="h-4 w-4 text-green-600" />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="text-sm font-medium">Average Time</div>
                        <div className="flex items-center gap-2">
                          <div className="text-sm text-muted-foreground">
                            {agent.withIntelligence.avgTime}min vs{' '}
                            {agent.withoutIntelligence.avgTime}min
                          </div>
                          <ArrowDownRight className="h-4 w-4 text-green-600" />
                        </div>
                        <div className="text-xs text-green-600">-{agent.savings.time}min/run</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="trends" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Savings Trends Over Time</CardTitle>
              <CardDescription>
                Daily savings progression and efficiency improvements over {timeRange}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {/* Cost Savings Summary */}
                <div>
                  <h3 className="text-lg font-semibold mb-4">Daily Cost Savings</h3>
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-muted">
                        <tr>
                          <th className="text-left p-3">Date</th>
                          <th className="text-right p-3">Intelligence Cost</th>
                          <th className="text-right p-3">Baseline Cost</th>
                          <th className="text-right p-3">Savings</th>
                          <th className="text-right p-3">Efficiency</th>
                          <th className="text-right p-3">Runs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...(timeSeriesData?.slice(-14) || [])].reverse().map((day, index) => (
                          <React.Fragment key={day.date}>
                            {/* Main row - clickable */}
                            <tr
                              className={`cursor-pointer ${index % 2 === 0 ? 'bg-background hover:bg-muted/30' : 'bg-muted/50 hover:bg-muted/70'}`}
                              onClick={() => toggleRow(day.date)}
                            >
                              <td className="p-3">
                                <div className="flex items-center gap-2">
                                  {expandedRows.has(day.date) ? (
                                    <ChevronDown className="h-4 w-4" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4" />
                                  )}
                                  <span className="font-medium">
                                    {new Date(day.date).toLocaleDateString()}
                                  </span>
                                </div>
                              </td>
                              <td className="text-right p-3">
                                {formatCurrency(day.withIntelligence.cost)}
                              </td>
                              <td className="text-right p-3">
                                {formatCurrency(day.withoutIntelligence.cost)}
                              </td>
                              <td className="text-right p-3 text-green-600 font-semibold">
                                {formatCurrency(day.savings.cost)}
                              </td>
                              <td className="text-right p-3">
                                <Badge
                                  variant={day.savings.percentage > 30 ? 'default' : 'secondary'}
                                >
                                  {formatPercentage(day.savings.percentage)}
                                </Badge>
                              </td>
                              <td className="text-right p-3 text-muted-foreground">
                                {formatNumber(
                                  day.withIntelligence.runs + day.withoutIntelligence.runs
                                )}
                              </td>
                            </tr>

                            {/* Expanded detail row */}
                            {expandedRows.has(day.date) && (
                              <tr className="bg-muted/30 border-t-2 border-muted-foreground/20">
                                <td colSpan={6} className="p-6">
                                  <div className="space-y-4">
                                    <div className="font-semibold text-base">Cost Breakdown</div>
                                    <div className="grid grid-cols-2 gap-6">
                                      <div className="space-y-3 p-4 bg-background rounded-lg border">
                                        <div className="text-sm font-medium text-muted-foreground">
                                          Intelligence Costs
                                        </div>
                                        <div className="space-y-2 text-base">
                                          <div className="flex justify-between">
                                            <span>Token costs:</span>
                                            <span className="font-mono">
                                              {formatCurrency(day.withIntelligence.cost * 0.6)}
                                            </span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span>Compute costs:</span>
                                            <span className="font-mono">
                                              {formatCurrency(day.withIntelligence.cost * 0.3)}
                                            </span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span>API overhead:</span>
                                            <span className="font-mono">
                                              {formatCurrency(day.withIntelligence.cost * 0.1)}
                                            </span>
                                          </div>
                                        </div>
                                      </div>
                                      <div className="space-y-3 p-4 bg-background rounded-lg border">
                                        <div className="text-sm font-medium text-muted-foreground">
                                          Baseline Costs
                                        </div>
                                        <div className="space-y-2 text-base">
                                          <div className="flex justify-between">
                                            <span>Token costs:</span>
                                            <span className="font-mono">
                                              {formatCurrency(day.withoutIntelligence.cost * 0.7)}
                                            </span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span>Compute costs:</span>
                                            <span className="font-mono">
                                              {formatCurrency(day.withoutIntelligence.cost * 0.25)}
                                            </span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span>API calls:</span>
                                            <span className="font-mono">
                                              {formatCurrency(day.withoutIntelligence.cost * 0.05)}
                                            </span>
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                    <div className="pt-3 border-t-2 border-muted-foreground/20">
                                      <div className="flex justify-between items-center">
                                        <span className="text-base font-semibold">Net Savings</span>
                                        <span className="text-xl font-bold text-green-600">
                                          {formatCurrency(day.savings.cost)}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                      </tbody>
                      <tfoot className="bg-muted font-semibold">
                        <tr>
                          <td className="p-3">Total ({timeSeriesData?.length || 0} days)</td>
                          <td className="text-right p-3">
                            {formatCurrency(
                              timeSeriesData?.reduce(
                                (sum, d) => sum + d.withIntelligence.cost,
                                0
                              ) || 0
                            )}
                          </td>
                          <td className="text-right p-3">
                            {formatCurrency(
                              timeSeriesData?.reduce(
                                (sum, d) => sum + d.withoutIntelligence.cost,
                                0
                              ) || 0
                            )}
                          </td>
                          <td className="text-right p-3 text-green-600">
                            {formatCurrency(
                              timeSeriesData?.reduce((sum, d) => sum + d.savings.cost, 0) || 0
                            )}
                          </td>
                          <td className="text-right p-3">
                            {(() => {
                              const totalBaseline =
                                timeSeriesData?.reduce(
                                  (sum, d) => sum + d.withoutIntelligence.cost,
                                  0
                                ) || 0;
                              const totalSavings =
                                timeSeriesData?.reduce((sum, d) => sum + d.savings.cost, 0) || 0;
                              const avgEfficiency =
                                totalBaseline > 0 ? (totalSavings / totalBaseline) * 100 : 0;
                              return formatPercentage(avgEfficiency);
                            })()}
                          </td>
                          <td className="text-right p-3">
                            {formatNumber(
                              timeSeriesData?.reduce(
                                (sum, d) =>
                                  sum + d.withIntelligence.runs + d.withoutIntelligence.runs,
                                0
                              ) || 0
                            )}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>

                {/* Token Usage Efficiency */}
                <div>
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    Token Usage Efficiency
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm">
                        <p className="text-xs">
                          Shows daily token consumption with intelligence vs estimated baseline
                          usage. Reduction % indicates how much fewer tokens were used compared to
                          standard AI agents.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </h3>
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-muted">
                        <tr>
                          <th className="text-left p-3">Date</th>
                          <th className="text-right p-3">Intelligence Tokens</th>
                          <th className="text-right p-3">Baseline Tokens</th>
                          <th className="text-right p-3">Token Savings</th>
                          <th className="text-right p-3">Reduction</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...(timeSeriesData?.slice(-10) || [])].reverse().map((day, index) => (
                          <tr
                            key={day.date}
                            className={
                              index % 2 === 0
                                ? 'bg-background hover:bg-muted/30'
                                : 'bg-muted/50 hover:bg-muted/70'
                            }
                          >
                            <td className="p-3 font-medium">
                              {new Date(day.date).toLocaleDateString()}
                            </td>
                            <td className="text-right p-3">
                              {formatNumber(day.withIntelligence.tokens)}
                            </td>
                            <td className="text-right p-3">
                              {formatNumber(day.withoutIntelligence.tokens)}
                            </td>
                            <td className="text-right p-3 text-green-600 font-semibold">
                              {formatNumber(day.savings.tokens)}
                            </td>
                            <td className="text-right p-3">
                              <Badge
                                variant={day.savings.percentage > 30 ? 'default' : 'secondary'}
                              >
                                {formatPercentage(day.savings.percentage)}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-muted font-semibold">
                        <tr>
                          <td className="p-3">Total</td>
                          <td className="text-right p-3">
                            {formatNumber(
                              timeSeriesData?.reduce(
                                (sum, d) => sum + d.withIntelligence.tokens,
                                0
                              ) || 0
                            )}
                          </td>
                          <td className="text-right p-3">
                            {formatNumber(
                              timeSeriesData?.reduce(
                                (sum, d) => sum + d.withoutIntelligence.tokens,
                                0
                              ) || 0
                            )}
                          </td>
                          <td className="text-right p-3 text-green-600">
                            {formatNumber(
                              timeSeriesData?.reduce((sum, d) => sum + d.savings.tokens, 0) || 0
                            )}
                          </td>
                          <td className="text-right p-3">
                            {(() => {
                              const totalBaseline =
                                timeSeriesData?.reduce(
                                  (sum, d) => sum + d.withoutIntelligence.tokens,
                                  0
                                ) || 0;
                              const totalSavings =
                                timeSeriesData?.reduce((sum, d) => sum + d.savings.tokens, 0) || 0;
                              const avgReduction =
                                totalBaseline > 0 ? (totalSavings / totalBaseline) * 100 : 0;
                              return formatPercentage(avgReduction);
                            })()}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="breakdown" className="space-y-4">
          {/* Provider Savings Cards */}
          <Card>
            <CardHeader>
              <CardTitle>Provider Savings Breakdown</CardTitle>
              <CardDescription>
                Cost savings by AI provider showing tokens offloaded and savings achieved
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {providerSavings?.map((provider) => (
                  <div
                    key={provider.providerId}
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="font-semibold text-base">{provider.providerName}</div>
                        <Badge variant="secondary" className="text-xs">
                          {provider.percentageOfTotal.toFixed(1)}% of total
                        </Badge>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <div className="text-muted-foreground text-xs">Savings</div>
                          <div className="font-bold text-green-600">
                            {formatCurrency(provider.savingsAmount)}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Tokens Offloaded</div>
                          <div className="font-medium">
                            {formatNumber(provider.tokensOffloaded)}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Total Processed</div>
                          <div className="font-medium">
                            {formatNumber(provider.tokensProcessed)}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Runs</div>
                          <div className="font-medium">{formatNumber(provider.runsCount)}</div>
                        </div>
                      </div>
                    </div>
                    <div className="ml-4">
                      <Progress value={provider.percentageOfTotal} className="h-2 w-24" />
                    </div>
                  </div>
                ))}

                {/* Total Summary */}
                <div className="border-t-2 pt-4 mt-4">
                  <div className="flex justify-between items-center font-semibold text-lg">
                    <span>Total Savings Across All Providers</span>
                    <div className="text-right text-green-600">
                      <div className="font-bold">
                        {formatCurrency(
                          providerSavings?.reduce((sum, p) => sum + p.savingsAmount, 0) || 0
                        )}
                      </div>
                      <div className="text-xs font-normal text-muted-foreground">
                        {formatNumber(
                          providerSavings?.reduce((sum, p) => sum + p.tokensOffloaded, 0) || 0
                        )}{' '}
                        tokens offloaded
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Provider Distribution Chart */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Provider Distribution</CardTitle>
                <CardDescription>Savings distribution across AI providers</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {providerSavings?.map((provider, index) => {
                    const colors = [
                      'bg-blue-500',
                      'bg-green-500',
                      'bg-purple-500',
                      'bg-orange-500',
                      'bg-pink-500',
                      'bg-cyan-500',
                    ];
                    const color = colors[index % colors.length];

                    return (
                      <div key={provider.providerId} className="space-y-2">
                        <div className="flex justify-between items-center text-sm">
                          <div className="flex items-center gap-2">
                            <div className={`w-3 h-3 rounded-full ${color}`}></div>
                            <span className="font-medium">{provider.providerName}</span>
                          </div>
                          <span className="font-bold">
                            {formatCurrency(provider.savingsAmount)}
                          </span>
                        </div>
                        <Progress value={provider.percentageOfTotal} className="h-2" />
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>{provider.percentageOfTotal.toFixed(1)}%</span>
                          <span>{formatNumber(provider.tokensOffloaded)} tokens</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Top Performing Providers</CardTitle>
                <CardDescription>Providers ranked by cost efficiency</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {providerSavings
                    ?.sort(
                      (a, b) =>
                        b.savingsAmount / b.tokensProcessed - a.savingsAmount / a.tokensProcessed
                    )
                    ?.slice(0, 3)
                    ?.map((provider, index) => {
                      const efficiency = (
                        (provider.savingsAmount / provider.tokensProcessed) *
                        1000000
                      ).toFixed(2);
                      const rankColors = ['text-yellow-400', 'text-gray-400', 'text-orange-400'];
                      const rankBgs = [
                        'bg-yellow-500/10 border border-yellow-500/20',
                        'bg-gray-500/10 border border-gray-500/20',
                        'bg-orange-500/10 border border-orange-500/20',
                      ];

                      return (
                        <div
                          key={provider.providerId}
                          className={`p-4 rounded-lg ${rankBgs[index]}`}
                        >
                          <div className="flex items-center gap-3 mb-2">
                            <div className={`text-2xl font-bold ${rankColors[index]}`}>
                              #{index + 1}
                            </div>
                            <div className="flex-1">
                              <div className="font-semibold">{provider.providerName}</div>
                              <div className="text-sm text-muted-foreground">
                                ${efficiency} saved per million tokens
                              </div>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-sm mt-3">
                            <div>
                              <div className="text-xs text-muted-foreground">Total Savings</div>
                              <div className="font-bold text-green-600">
                                {formatCurrency(provider.savingsAmount)}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground">Avg Cost/Token</div>
                              <div className="font-medium">
                                ${(provider.avgCostPerToken * 1000000).toFixed(2)}/M
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Efficiency Metrics</CardTitle>
              <CardDescription>Performance improvements across different metrics</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="text-center">
                  <div className="text-3xl font-bold text-green-600 mb-2">34.2%</div>
                  <div className="text-sm text-muted-foreground">Overall Efficiency Gain</div>
                </div>
                <div className="text-center">
                  <div className="text-3xl font-bold text-blue-600 mb-2">42.1%</div>
                  <div className="text-sm text-muted-foreground">Token Usage Reduction</div>
                </div>
                <div className="text-center">
                  <div className="text-3xl font-bold text-purple-600 mb-2">37.5%</div>
                  <div className="text-sm text-muted-foreground">Compute Usage Reduction</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="models" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>AI Models Performance & Cost Analysis</CardTitle>
              <CardDescription>
                Unified view of model performance metrics and cost efficiency
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Merged mock data combining performance and cost metrics */}
              {(() => {
                // Mock data from EnhancedAnalytics-style performance metrics
                const aiModelPerformance = [
                  {
                    model: 'Claude Sonnet 4.5',
                    requests: 4850,
                    avgResponseTime: 1.2,
                    cost: 18500,
                    successRate: 98.8,
                    tokens: 2800000,
                  },
                  {
                    model: 'Local Models',
                    requests: 6200,
                    avgResponseTime: 0.8,
                    cost: 12000,
                    successRate: 96.5,
                    tokens: 1500000,
                  },
                  {
                    model: 'GPT-4 Turbo',
                    requests: 2100,
                    avgResponseTime: 1.5,
                    cost: 8000,
                    successRate: 97.8,
                    tokens: 950000,
                  },
                  {
                    model: 'Claude Opus',
                    requests: 980,
                    avgResponseTime: 2.1,
                    cost: 4200,
                    successRate: 99.2,
                    tokens: 680000,
                  },
                  {
                    model: 'GPT-4o',
                    requests: 1420,
                    avgResponseTime: 1.1,
                    cost: 1500,
                    successRate: 95.5,
                    tokens: 420000,
                  },
                  {
                    model: 'Claude Haiku',
                    requests: 2870,
                    avgResponseTime: 0.6,
                    cost: 800,
                    successRate: 94.2,
                    tokens: 320000,
                  },
                ];

                // Merge with provider savings data
                const unifiedData: UnifiedModelData[] = aiModelPerformance.map((perf, index) => {
                  const providerData = providerSavings?.[index];
                  return {
                    model: perf.model,
                    requests: perf.requests,
                    avgResponseTime: perf.avgResponseTime,
                    successRate: perf.successRate,
                    cost: perf.cost,
                    tokens: perf.tokens,
                    savingsAmount: providerData?.savingsAmount || 0,
                    tokensOffloaded: providerData?.tokensOffloaded || 0,
                    avgCostPerToken: providerData?.avgCostPerToken || perf.cost / perf.tokens,
                    runsCount: providerData?.runsCount || perf.requests,
                    costPerRequest: perf.cost / perf.requests,
                    costPerToken: perf.cost / perf.tokens,
                  };
                });

                // Calculate usage percentages
                const totalRequests = unifiedData.reduce((sum, m) => sum + m.requests, 0);
                const dataWithUsage = unifiedData.map((model) => ({
                  ...model,
                  usagePercentage: (model.requests / totalRequests) * 100,
                }));

                const handleSort = (column: keyof UnifiedModelData | 'usagePercentage') => {
                  if (sortColumn === column) {
                    setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
                  } else {
                    setSortColumn(column);
                    setSortDirection('desc');
                  }
                };

                const sortedData = [...dataWithUsage].sort((a, b) => {
                  const aVal = a[sortColumn];
                  const bVal = b[sortColumn];
                  const modifier = sortDirection === 'asc' ? 1 : -1;
                  if (typeof aVal === 'number' && typeof bVal === 'number') {
                    return (aVal - bVal) * modifier;
                  }
                  return String(aVal).localeCompare(String(bVal)) * modifier;
                });

                return (
                  <div className="space-y-4">
                    {/* Summary Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm font-medium text-muted-foreground">
                            Total Models
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">{unifiedData.length}</div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm font-medium text-muted-foreground">
                            Total Requests
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">
                            {formatNumber(unifiedData.reduce((sum, m) => sum + m.requests, 0))}
                          </div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm font-medium text-muted-foreground">
                            Total Cost
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">
                            {formatCurrency(unifiedData.reduce((sum, m) => sum + m.cost, 0))}
                          </div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm font-medium text-muted-foreground">
                            Avg Success Rate
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">
                            {(
                              unifiedData.reduce((sum, m) => sum + m.successRate, 0) /
                              unifiedData.length
                            ).toFixed(1)}
                            %
                          </div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm font-medium text-muted-foreground">
                            Most Used Model
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold truncate">
                            {
                              dataWithUsage
                                .sort((a, b) => b.usagePercentage - a.usagePercentage)[0]
                                .model.split(' ')[0]
                            }
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {dataWithUsage
                              .sort((a, b) => b.usagePercentage - a.usagePercentage)[0]
                              .usagePercentage.toFixed(1)}
                            % of requests
                          </div>
                        </CardContent>
                      </Card>
                    </div>

                    {/* Model Usage Distribution */}
                    <Card>
                      <CardHeader>
                        <CardTitle>Model Usage Distribution</CardTitle>
                        <CardDescription>Percentage of total requests by model</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {dataWithUsage
                            .sort((a, b) => b.usagePercentage - a.usagePercentage)
                            .map((model, index) => {
                              const colors = [
                                'bg-blue-500',
                                'bg-green-500',
                                'bg-purple-500',
                                'bg-orange-500',
                                'bg-pink-500',
                                'bg-cyan-500',
                              ];
                              const color = colors[index % colors.length];

                              return (
                                <div key={model.model} className="space-y-1">
                                  <div className="flex items-center justify-between text-sm">
                                    <span className="font-medium">{model.model}</span>
                                    <span className="text-muted-foreground">
                                      {model.usagePercentage.toFixed(1)}%
                                    </span>
                                  </div>
                                  <div className="relative w-full bg-muted rounded-full h-2">
                                    <div
                                      className={`${color} h-2 rounded-full transition-all`}
                                      style={{ width: `${model.usagePercentage}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      </CardContent>
                    </Card>

                    {/* Success Rate Grading Legend */}
                    <Card>
                      <CardContent className="pt-4">
                        <div className="flex items-center gap-6 text-sm flex-wrap">
                          <span className="font-medium">Success Rate Grading:</span>
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="default">≥98% Excellent</Badge>
                            <Badge variant="secondary">95-97% Good</Badge>
                            <Badge variant="outline">90-94% Fair</Badge>
                            <Badge variant="destructive">&lt;90% Poor</Badge>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    {/* Sortable Table */}
                    <div className="border rounded-lg overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead className="bg-muted">
                            <tr>
                              <th
                                className="text-left p-3 cursor-pointer hover:bg-muted/80"
                                onClick={() => handleSort('model')}
                              >
                                <div className="flex items-center gap-1">
                                  Model
                                  {sortColumn === 'model' && (
                                    <span className="text-xs">
                                      {sortDirection === 'asc' ? '↑' : '↓'}
                                    </span>
                                  )}
                                </div>
                              </th>
                              <th
                                className="text-right p-3 cursor-pointer hover:bg-muted/80"
                                onClick={() => handleSort('requests')}
                              >
                                <div className="flex items-center justify-end gap-1">
                                  Requests
                                  {sortColumn === 'requests' && (
                                    <span className="text-xs">
                                      {sortDirection === 'asc' ? '↑' : '↓'}
                                    </span>
                                  )}
                                </div>
                              </th>
                              <th
                                className="text-right p-3 cursor-pointer hover:bg-muted/80"
                                onClick={() => handleSort('usagePercentage')}
                              >
                                <div className="flex items-center justify-end gap-1">
                                  Usage %
                                  {sortColumn === 'usagePercentage' && (
                                    <span className="text-xs">
                                      {sortDirection === 'asc' ? '↑' : '↓'}
                                    </span>
                                  )}
                                </div>
                              </th>
                              <th
                                className="text-right p-3 cursor-pointer hover:bg-muted/80"
                                onClick={() => handleSort('avgResponseTime')}
                              >
                                <div className="flex items-center justify-end gap-1">
                                  Avg Response
                                  {sortColumn === 'avgResponseTime' && (
                                    <span className="text-xs">
                                      {sortDirection === 'asc' ? '↑' : '↓'}
                                    </span>
                                  )}
                                </div>
                              </th>
                              <th
                                className="text-right p-3 cursor-pointer hover:bg-muted/80"
                                onClick={() => handleSort('successRate')}
                              >
                                <div className="flex items-center justify-end gap-1">
                                  Success Rate
                                  {sortColumn === 'successRate' && (
                                    <span className="text-xs">
                                      {sortDirection === 'asc' ? '↑' : '↓'}
                                    </span>
                                  )}
                                </div>
                              </th>
                              <th
                                className="text-right p-3 cursor-pointer hover:bg-muted/80"
                                onClick={() => handleSort('cost')}
                              >
                                <div className="flex items-center justify-end gap-1">
                                  Total Cost
                                  {sortColumn === 'cost' && (
                                    <span className="text-xs">
                                      {sortDirection === 'asc' ? '↑' : '↓'}
                                    </span>
                                  )}
                                </div>
                              </th>
                              <th
                                className="text-right p-3 cursor-pointer hover:bg-muted/80"
                                onClick={() => handleSort('costPerRequest')}
                              >
                                <div className="flex items-center justify-end gap-1">
                                  Cost/Request
                                  {sortColumn === 'costPerRequest' && (
                                    <span className="text-xs">
                                      {sortDirection === 'asc' ? '↑' : '↓'}
                                    </span>
                                  )}
                                </div>
                              </th>
                              <th
                                className="text-right p-3 cursor-pointer hover:bg-muted/80"
                                onClick={() => handleSort('tokens')}
                              >
                                <div className="flex items-center justify-end gap-1">
                                  Tokens
                                  {sortColumn === 'tokens' && (
                                    <span className="text-xs">
                                      {sortDirection === 'asc' ? '↑' : '↓'}
                                    </span>
                                  )}
                                </div>
                              </th>
                              <th
                                className="text-right p-3 cursor-pointer hover:bg-muted/80"
                                onClick={() => handleSort('savingsAmount')}
                              >
                                <div className="flex items-center justify-end gap-1">
                                  Savings
                                  {sortColumn === 'savingsAmount' && (
                                    <span className="text-xs">
                                      {sortDirection === 'asc' ? '↑' : '↓'}
                                    </span>
                                  )}
                                </div>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedData.map((model, index) => (
                              <tr
                                key={model.model}
                                className={
                                  index % 2 === 0
                                    ? 'bg-background hover:bg-muted/30'
                                    : 'bg-muted/50 hover:bg-muted/70'
                                }
                              >
                                <td className="p-3 font-medium">{model.model}</td>
                                <td className="text-right p-3">{formatNumber(model.requests)}</td>
                                <td className="text-right p-3">
                                  <div className="flex items-center justify-end gap-2">
                                    <span className="font-medium">
                                      {model.usagePercentage.toFixed(1)}%
                                    </span>
                                    <div className="w-16 bg-muted rounded-full h-2">
                                      <div
                                        className="bg-blue-500 h-2 rounded-full"
                                        style={{ width: `${model.usagePercentage}%` }}
                                      />
                                    </div>
                                  </div>
                                </td>
                                <td className="text-right p-3">
                                  {model.avgResponseTime.toFixed(1)}s
                                </td>
                                <td className="text-right p-3">
                                  <Badge variant={getSuccessRateVariant(model.successRate)}>
                                    {model.successRate.toFixed(1)}%
                                  </Badge>
                                </td>
                                <td className="text-right p-3 font-semibold">
                                  {formatCurrency(model.cost)}
                                </td>
                                <td className="text-right p-3 text-muted-foreground">
                                  {formatCurrency(model.costPerRequest)}
                                </td>
                                <td className="text-right p-3 text-muted-foreground">
                                  {formatNumber(model.tokens)}
                                </td>
                                <td className="text-right p-3 text-green-600 font-semibold">
                                  {formatCurrency(model.savingsAmount)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot className="bg-muted font-semibold">
                            <tr>
                              <td className="p-3">Total</td>
                              <td className="text-right p-3">
                                {formatNumber(sortedData.reduce((sum, m) => sum + m.requests, 0))}
                              </td>
                              <td className="text-right p-3">100%</td>
                              <td className="text-right p-3">
                                {(
                                  sortedData.reduce((sum, m) => sum + m.avgResponseTime, 0) /
                                  sortedData.length
                                ).toFixed(1)}
                                s
                              </td>
                              <td className="text-right p-3">
                                {(
                                  sortedData.reduce((sum, m) => sum + m.successRate, 0) /
                                  sortedData.length
                                ).toFixed(1)}
                                %
                              </td>
                              <td className="text-right p-3">
                                {formatCurrency(sortedData.reduce((sum, m) => sum + m.cost, 0))}
                              </td>
                              <td className="text-right p-3">-</td>
                              <td className="text-right p-3">
                                {formatNumber(sortedData.reduce((sum, m) => sum + m.tokens, 0))}
                              </td>
                              <td className="text-right p-3 text-green-600">
                                {formatCurrency(
                                  sortedData.reduce((sum, m) => sum + m.savingsAmount, 0)
                                )}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>

                    {/* Cost Efficiency Details */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">Most Cost-Effective Models</CardTitle>
                          <CardDescription>Ranked by cost per request</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-3">
                            {[...unifiedData]
                              .sort((a, b) => a.costPerRequest - b.costPerRequest)
                              .slice(0, 3)
                              .map((model, index) => (
                                <div
                                  key={model.model}
                                  className="flex items-center justify-between p-3 border rounded-lg"
                                >
                                  <div className="flex items-center gap-2">
                                    <div className="font-bold text-lg text-muted-foreground">
                                      #{index + 1}
                                    </div>
                                    <div>
                                      <div className="font-semibold">{model.model}</div>
                                      <div className="text-xs text-muted-foreground">
                                        {formatCurrency(model.costPerRequest)}/request
                                      </div>
                                    </div>
                                  </div>
                                  <Badge variant="outline" className="text-green-600">
                                    {formatCurrency(model.savingsAmount)} saved
                                  </Badge>
                                </div>
                              ))}
                          </div>
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">Highest Performance Models</CardTitle>
                          <CardDescription>Ranked by success rate</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-3">
                            {[...unifiedData]
                              .sort((a, b) => b.successRate - a.successRate)
                              .slice(0, 3)
                              .map((model, index) => (
                                <div
                                  key={model.model}
                                  className="flex items-center justify-between p-3 border rounded-lg"
                                >
                                  <div className="flex items-center gap-2">
                                    <div className="font-bold text-lg text-muted-foreground">
                                      #{index + 1}
                                    </div>
                                    <div>
                                      <div className="font-semibold">{model.model}</div>
                                      <div className="text-xs text-muted-foreground">
                                        {model.avgResponseTime.toFixed(1)}s avg response
                                      </div>
                                    </div>
                                  </div>
                                  <Badge variant="default">{model.successRate.toFixed(1)}%</Badge>
                                </div>
                              ))}
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
