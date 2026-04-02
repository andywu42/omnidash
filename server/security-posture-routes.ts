/**
 * Security Posture API Routes (feature-hookup Phase 4)
 *
 * REST endpoints for security posture dashboard:
 *   GET /api/security-posture         — latest workflow run conclusions for security scans
 *   GET /api/security-posture/sbom    — SBOM artifact availability per image
 *
 * Fetches data from GitHub Actions API using GH_PAT env var.
 * Falls back to empty results when GH_PAT is not configured.
 */

import { Router } from 'express';

const router = Router();

const GH_ORG = 'OmniNode-ai';

// Repos with security-related workflows
const SECURITY_REPOS = [
  {
    repo: 'omninode_infra',
    workflows: [
      'security-scan.yml',
      'build-and-push-onex-api.yml',
      'build-and-push-omnidash.yml',
      'build-and-push-cloud-migrate-image.yml',
    ],
  },
  { repo: 'omnibase_infra', workflows: ['docker-build.yml'] },
  { repo: 'omnibase_core', workflows: ['ci.yml'] },
];

interface WorkflowRunSummary {
  repo: string;
  workflow: string;
  conclusion: string | null;
  status: string;
  runNumber: number;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  headBranch: string;
  headSha: string;
}

interface SecurityPostureResponse {
  configured: boolean;
  runs: WorkflowRunSummary[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    inProgress: number;
  };
  fetchedAt: string;
}

async function fetchGitHubWorkflowRuns(
  token: string,
  owner: string,
  repo: string,
  workflowFile: string
): Promise<WorkflowRunSummary[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=5&branch=main`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    console.warn(`[security-posture] GitHub API ${res.status} for ${repo}/${workflowFile}`);
    return [];
  }

  const data = await res.json();
  const workflowRuns = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];

  return workflowRuns.map((run: Record<string, unknown>) => ({
    repo,
    workflow: workflowFile,
    conclusion: (run?.conclusion as string | null) ?? null,
    status: (run?.status as string) ?? 'unknown',
    runNumber: (run?.run_number as number) ?? 0,
    htmlUrl: (run?.html_url as string) ?? '',
    createdAt: (run?.created_at as string) ?? '',
    updatedAt: (run?.updated_at as string) ?? '',
    headBranch: (run?.head_branch as string) ?? '',
    headSha: (run?.head_sha as string) ?? '',
  }));
}

// ============================================================================
// GET /api/security-posture
// Latest workflow run conclusions for security-related workflows
// ============================================================================

router.get('/', async (_req, res) => {
  const token = process.env.GH_PAT;

  if (!token) {
    return res.json({
      configured: false,
      runs: [],
      summary: { total: 0, passed: 0, failed: 0, inProgress: 0 },
      fetchedAt: new Date().toISOString(),
    } satisfies SecurityPostureResponse);
  }

  try {
    const allPromises = SECURITY_REPOS.flatMap(({ repo, workflows }) =>
      workflows.map((wf) => fetchGitHubWorkflowRuns(token, GH_ORG, repo, wf))
    );

    const results = await Promise.all(allPromises);
    const runs = results.flat();

    // Take only the latest run per repo/workflow combination
    const latestByKey = new Map<string, WorkflowRunSummary>();
    for (const run of runs) {
      const key = `${run.repo}/${run.workflow}`;
      const existing = latestByKey.get(key);
      if (!existing || new Date(run.createdAt) > new Date(existing.createdAt)) {
        latestByKey.set(key, run);
      }
    }

    const latestRuns = Array.from(latestByKey.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const passed = latestRuns.filter((r) => r.conclusion === 'success').length;
    const failed = latestRuns.filter((r) => r.conclusion === 'failure').length;
    const inProgress = latestRuns.filter((r) => r.status !== 'completed').length;

    return res.json({
      configured: true,
      runs: latestRuns,
      summary: {
        total: latestRuns.length,
        passed,
        failed,
        inProgress,
      },
      fetchedAt: new Date().toISOString(),
    } satisfies SecurityPostureResponse);
  } catch (err) {
    console.error('[security-posture] Failed to fetch workflow runs:', err);
    return res.status(500).json({ error: 'Failed to fetch security posture data' });
  }
});

// ============================================================================
// GET /api/security-posture/sbom
// Check which images have SBOM artifacts from recent builds
// ============================================================================

router.get('/sbom', async (_req, res) => {
  const token = process.env.GH_PAT;

  if (!token) {
    return res.json({ configured: false, images: [] });
  }

  try {
    const sbomWorkflows = [
      { repo: 'omninode_infra', workflow: 'build-and-push-onex-api.yml', image: 'onex-api' },
      { repo: 'omninode_infra', workflow: 'build-and-push-omnidash.yml', image: 'omnidash' },
      {
        repo: 'omninode_infra',
        workflow: 'build-and-push-cloud-migrate-image.yml',
        image: 'cloud-migrate',
      },
    ];

    const images = await Promise.all(
      sbomWorkflows.map(async ({ repo, workflow, image }) => {
        const runs = await fetchGitHubWorkflowRuns(token, GH_ORG, repo, workflow);
        const latest = runs[0];
        return {
          image,
          repo,
          workflow,
          lastBuild: latest
            ? {
                conclusion: latest.conclusion,
                createdAt: latest.createdAt,
                runNumber: latest.runNumber,
                htmlUrl: latest.htmlUrl,
                headSha: latest.headSha,
              }
            : null,
          sbomAvailable: latest?.conclusion === 'success',
        };
      })
    );

    return res.json({ configured: true, images });
  } catch (err) {
    console.error('[security-posture] Failed to fetch SBOM status:', err);
    return res.status(500).json({ error: 'Failed to fetch SBOM data' });
  }
});

export default router;
