/**
 * Validation Dashboard Data Source
 *
 * Fetches cross-repo validation data from API endpoints.
 *
 * Part of OMN-1907: Cross-Repo Validation Dashboard Integration
 */

import type { ValidationRun, RepoTrends, LifecycleSummary } from '@shared/validation-types';

// ===========================
// Types
// ===========================

export interface ValidationSummary {
  total_runs: number;
  completed_runs: number;
  running_runs: number;
  unique_repos: number;
  repos: string[];
  pass_rate: number;
  total_violations_by_severity: Record<string, number>;
}

export interface RunSummary {
  run_id: string;
  repos: string[];
  validators: string[];
  triggered_by?: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  total_violations: number;
  violations_by_severity: Record<string, number>;
  violation_count: number;
}

export interface RunsListResponse {
  runs: RunSummary[];
  total: number;
  limit: number;
  offset: number;
}

// ===========================
// Data Source Class
// ===========================

class ValidationSource {
  private baseUrl = '/api/validation';

  async summary(): Promise<ValidationSummary> {
    const response = await fetch(`${this.baseUrl}/summary`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async listRuns(
    params: { status?: string; limit?: number; offset?: number } = {}
  ): Promise<RunsListResponse> {
    const query = new URLSearchParams();
    if (params.status && params.status !== 'all') query.set('status', params.status);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));

    const url = query.toString() ? `${this.baseUrl}/runs?${query}` : `${this.baseUrl}/runs`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async getRunDetail(runId: string): Promise<ValidationRun | null> {
    const response = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async getLifecycleSummary(): Promise<LifecycleSummary> {
    const response = await fetch(`${this.baseUrl}/lifecycle/summary`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async getRepoTrends(repoId: string): Promise<RepoTrends> {
    const response = await fetch(`${this.baseUrl}/repos/${encodeURIComponent(repoId)}/trends`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
}

// ===========================
// Export Singleton
// ===========================

export const validationSource = new ValidationSource();
