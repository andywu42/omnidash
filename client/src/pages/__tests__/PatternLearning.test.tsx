/**
 * PatternLearning Page Tests
 *
 * Tests for client-side filtering logic in the PATLEARN dashboard.
 * Covers: state filters, pattern type filters, search filters, combined filters,
 * limit/pagination, and filter clearing.
 *
 * Part of OMN-1699: Pattern Dashboard with Evidence-Based Score Debugging
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import PatternLearning from '@/pages/PatternLearning';
import { patlearnSource, type PatlearnArtifact, type PatlearnSummary } from '@/lib/data-sources';
import { DemoModeProvider } from '@/contexts/DemoModeContext';

// ===========================
// Mocks
// ===========================

// Mock wouter's useSearch hook to return empty search params by default
// This can be overridden per-test using mockSearchParams
// Using an object to avoid hoisting issues with vi.mock
const mockState = { searchString: '' };

vi.mock('wouter', () => ({
  useSearch: () => mockState.searchString,
}));

/**
 * Set mock URL search params for the next test
 * Call before rendering the component
 */
function mockSearchParams(params: Record<string, string>) {
  const searchParams = new URLSearchParams(params);
  mockState.searchString = searchParams.toString();
}

/**
 * Reset search params to empty string
 * Should be called in afterEach
 */
function resetSearchParams() {
  mockState.searchString = '';
}

vi.mock('@/lib/data-sources', async () => {
  const actual = await vi.importActual<typeof import('@/lib/data-sources')>('@/lib/data-sources');
  return {
    ...actual,
    patlearnSource: {
      list: vi.fn(),
      summary: vi.fn(),
      detail: vi.fn(),
    },
  };
});

// ===========================
// Test Helpers
// ===========================

let queryClient: QueryClient | null = null;

function renderWithClient(ui: ReactNode) {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchInterval: false,
        refetchOnWindowFocus: false,
        gcTime: Infinity,
        staleTime: Infinity,
      },
    },
  });

  const result = render(
    <DemoModeProvider>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </DemoModeProvider>
  );

  return { queryClient, ...result };
}

/**
 * Create a mock PatlearnArtifact with sensible defaults
 * All required fields are provided; override specific fields as needed
 */
function createMockPattern(overrides: Partial<PatlearnArtifact> = {}): PatlearnArtifact {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    patternId: overrides.patternId ?? crypto.randomUUID(),
    patternName: overrides.patternName ?? 'Test Pattern',
    patternType: overrides.patternType ?? 'behavioral',
    language: overrides.language ?? 'TypeScript',
    lifecycleState: overrides.lifecycleState ?? 'validated',
    stateChangedAt: overrides.stateChangedAt,
    compositeScore: overrides.compositeScore ?? 0.85,
    scoringEvidence: overrides.scoringEvidence ?? {
      labelAgreement: {
        score: 0.9,
        matchedLabels: ['async', 'error-handling'],
        totalLabels: 3,
      },
      clusterCohesion: {
        score: 0.85,
        clusterId: 'cluster-1',
        memberCount: 5,
        avgPairwiseSimilarity: 0.82,
      },
      frequencyFactor: {
        score: 0.8,
        observedCount: 12,
        minRequired: 5,
        windowDays: 7,
      },
    },
    signature: overrides.signature ?? {
      hash: 'abc123',
      version: '1.0.0',
      algorithm: 'sha256',
      inputs: ['pattern-data'],
    },
    metrics: overrides.metrics ?? {
      processingTimeMs: 120,
      inputCount: 10,
      clusterCount: 3,
      dedupMergeCount: 2,
    },
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt,
    metadata: overrides.metadata,
  };
}

/**
 * Create a mock PatlearnSummary
 */
function createMockSummary(overrides: Partial<PatlearnSummary> = {}): PatlearnSummary {
  return {
    totalPatterns: overrides.totalPatterns ?? 100,
    byState: overrides.byState ?? {
      requested: 0,
      candidate: 20,
      provisional: 15,
      validated: 55,
      deprecated: 10,
    },
    avgScores: overrides.avgScores ?? {
      labelAgreement: 0.85,
      clusterCohesion: 0.8,
      frequencyFactor: 0.75,
      composite: 0.82,
    },
    window: overrides.window ?? '24h',
    promotionsInWindow: overrides.promotionsInWindow ?? 5,
    deprecationsInWindow: overrides.deprecationsInWindow ?? 2,
  };
}

// ===========================
// Test Suite
// ===========================

describe('PatternLearning page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(async () => {
    if (queryClient) {
      queryClient.clear();
      await queryClient.cancelQueries();
      queryClient = null;
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    resetSearchParams();
  });

  // ===========================
  // Basic Rendering Tests
  // ===========================

  describe('Basic Rendering', () => {
    it('renders the page with title and filter bar', async () => {
      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([createMockPattern()]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getByText('Pattern Learning')).toBeInTheDocument();
      });

      expect(screen.getByText('Filters:')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Search patterns...')).toBeInTheDocument();

      result.unmount();
    });

    it('shows loading skeletons while data is loading', async () => {
      vi.mocked(patlearnSource.summary).mockImplementation(() => new Promise(() => {}));
      vi.mocked(patlearnSource.list).mockImplementation(() => new Promise(() => {}));

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      // Check for skeleton elements (loading state) - they have animate-pulse class
      // Wrap in waitFor because TanStack Query's isLoading state may not be true synchronously
      await waitFor(() => {
        const skeletons = document.querySelectorAll('.animate-pulse');
        expect(skeletons.length).toBeGreaterThan(0);
      });

      result.unmount();
    });

    it('displays patterns in the table when loaded', async () => {
      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'Auth Handler Pattern', patternType: 'security' }),
        createMockPattern({ patternName: 'Retry Logic Pattern', patternType: 'resilience' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      // Pattern names appear in multiple components (timeline, top patterns, main table)
      // so we use getAllByText to verify at least one instance is rendered
      await waitFor(() => {
        expect(screen.getAllByText('Auth Handler Pattern').length).toBeGreaterThan(0);
      });

      expect(screen.getAllByText('Retry Logic Pattern').length).toBeGreaterThan(0);

      result.unmount();
    });
  });

  // ===========================
  // State Filter Tests
  // ===========================

  describe('State Filter', () => {
    it('filters patterns by lifecycle state (validated)', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'Validated Pattern', lifecycleState: 'validated' }),
        createMockPattern({ patternName: 'Candidate Pattern', lifecycleState: 'candidate' }),
        createMockPattern({ patternName: 'Provisional Pattern', lifecycleState: 'provisional' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getAllByText('Validated Pattern').length).toBeGreaterThan(0);
      });

      // All patterns should be visible initially
      expect(screen.getAllByText('Candidate Pattern').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Provisional Pattern').length).toBeGreaterThan(0);

      // Find and click the state filter dropdown (first combobox)
      const comboboxes = screen.getAllByRole('combobox');
      const stateSelect = comboboxes[0]; // State is first
      await user.click(stateSelect);

      // Select 'Validated' option
      const validatedOption = screen.getByRole('option', { name: /validated/i });
      await user.click(validatedOption);

      // Now only validated patterns should be visible
      await waitFor(() => {
        expect(screen.getAllByText('Validated Pattern').length).toBeGreaterThan(0);
      });
      expect(screen.queryAllByText('Candidate Pattern')).toHaveLength(0);
      expect(screen.queryAllByText('Provisional Pattern')).toHaveLength(0);

      // State filter badge should appear
      expect(screen.getByText('State: validated')).toBeInTheDocument();

      result.unmount();
    });

    it('filters patterns by candidate state', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'Validated Pattern', lifecycleState: 'validated' }),
        createMockPattern({ patternName: 'Candidate Pattern', lifecycleState: 'candidate' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Validated Pattern').length).toBeGreaterThan(0);
      });

      const comboboxes = screen.getAllByRole('combobox');
      const stateSelect = comboboxes[0];
      await user.click(stateSelect);

      const candidateOption = screen.getByRole('option', { name: /candidate/i });
      await user.click(candidateOption);

      await waitFor(() => {
        expect(screen.getAllByText('Candidate Pattern').length).toBeGreaterThan(0);
      });
      expect(screen.queryAllByText('Validated Pattern')).toHaveLength(0);

      result.unmount();
    });

    it('filters patterns by deprecated state', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'Active Pattern', lifecycleState: 'validated' }),
        createMockPattern({ patternName: 'Old Pattern', lifecycleState: 'deprecated' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Active Pattern').length).toBeGreaterThan(0);
      });

      const comboboxes = screen.getAllByRole('combobox');
      const stateSelect = comboboxes[0];
      await user.click(stateSelect);

      const deprecatedOption = screen.getByRole('option', { name: /deprecated/i });
      await user.click(deprecatedOption);

      await waitFor(() => {
        expect(screen.getAllByText('Old Pattern').length).toBeGreaterThan(0);
      });
      expect(screen.queryAllByText('Active Pattern')).toHaveLength(0);

      result.unmount();
    });
  });

  // ===========================
  // Pattern Type Filter Tests
  // ===========================

  describe('Pattern Type Filter', () => {
    it('filters patterns by pattern type', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'Security Handler', patternType: 'security' }),
        createMockPattern({ patternName: 'Behavioral Pattern', patternType: 'behavioral' }),
        createMockPattern({ patternName: 'Auth Guard', patternType: 'security' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Security Handler').length).toBeGreaterThan(0);
      });

      // All patterns visible initially
      expect(screen.getAllByText('Behavioral Pattern').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Auth Guard').length).toBeGreaterThan(0);

      // Find and click the pattern type filter dropdown (second combobox)
      const comboboxes = screen.getAllByRole('combobox');
      const typeSelect = comboboxes[1]; // Type is second
      await user.click(typeSelect);

      // Select 'security' option
      const securityOption = screen.getByRole('option', { name: /security/i });
      await user.click(securityOption);

      // Only security patterns should be visible
      await waitFor(() => {
        expect(screen.getAllByText('Security Handler').length).toBeGreaterThan(0);
      });
      expect(screen.getAllByText('Auth Guard').length).toBeGreaterThan(0);
      expect(screen.queryAllByText('Behavioral Pattern')).toHaveLength(0);

      // Type filter badge should appear
      expect(screen.getByText('Type: security')).toBeInTheDocument();

      result.unmount();
    });

    it('dynamically populates pattern type options from data', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternType: 'structural' }),
        createMockPattern({ patternType: 'behavioral' }),
        createMockPattern({ patternType: 'creational' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getByTestId('page-pattern-learning')).toBeInTheDocument();
      });

      // Open the type dropdown (second combobox)
      const comboboxes = screen.getAllByRole('combobox');
      const typeSelect = comboboxes[1];
      await user.click(typeSelect);

      // All unique types should be available (sorted alphabetically)
      expect(screen.getByRole('option', { name: /behavioral/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /creational/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /structural/i })).toBeInTheDocument();

      result.unmount();
    });
  });

  // ===========================
  // Search Filter Tests
  // ===========================

  describe('Search Filter', () => {
    it('filters patterns by name search', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'Authentication Handler' }),
        createMockPattern({ patternName: 'Retry Logic' }),
        createMockPattern({ patternName: 'Auth Token Validator' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Authentication Handler').length).toBeGreaterThan(0);
      });

      // Type in search box
      const searchInput = screen.getByPlaceholderText('Search patterns...');
      await user.type(searchInput, 'Auth');

      // Should match patterns containing 'Auth'
      await waitFor(() => {
        expect(screen.getAllByText('Authentication Handler').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Auth Token Validator').length).toBeGreaterThan(0);
      });
      expect(screen.queryAllByText('Retry Logic')).toHaveLength(0);

      // Search badge should appear
      expect(screen.getByText('Search: "Auth"')).toBeInTheDocument();

      result.unmount();
    });

    it('filters patterns by language search', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'TS Pattern', language: 'TypeScript' }),
        createMockPattern({ patternName: 'Python Pattern', language: 'Python' }),
        createMockPattern({ patternName: 'JS Pattern', language: 'JavaScript' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('TS Pattern').length).toBeGreaterThan(0);
      });

      const searchInput = screen.getByPlaceholderText('Search patterns...');
      await user.type(searchInput, 'Python');

      await waitFor(() => {
        expect(screen.getAllByText('Python Pattern').length).toBeGreaterThan(0);
      });
      expect(screen.queryAllByText('TS Pattern')).toHaveLength(0);
      expect(screen.queryAllByText('JS Pattern')).toHaveLength(0);

      result.unmount();
    });

    it('filters patterns by pattern type via search', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'Pattern A', patternType: 'security' }),
        createMockPattern({ patternName: 'Pattern B', patternType: 'behavioral' }),
        createMockPattern({ patternName: 'Pattern C', patternType: 'security-audit' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Pattern A').length).toBeGreaterThan(0);
      });

      const searchInput = screen.getByPlaceholderText('Search patterns...');
      await user.type(searchInput, 'security');

      await waitFor(() => {
        expect(screen.getAllByText('Pattern A').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Pattern C').length).toBeGreaterThan(0);
      });
      expect(screen.queryAllByText('Pattern B')).toHaveLength(0);

      result.unmount();
    });

    it('search is case-insensitive', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'AUTHENTICATION Handler' }),
        createMockPattern({ patternName: 'other pattern' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('AUTHENTICATION Handler').length).toBeGreaterThan(0);
      });

      const searchInput = screen.getByPlaceholderText('Search patterns...');
      await user.type(searchInput, 'authentication');

      await waitFor(() => {
        expect(screen.getAllByText('AUTHENTICATION Handler').length).toBeGreaterThan(0);
      });
      expect(screen.queryAllByText('other pattern')).toHaveLength(0);

      result.unmount();
    });
  });

  // ===========================
  // Combined Filters Tests
  // ===========================

  describe('Combined Filters', () => {
    it('applies multiple filters simultaneously', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({
          patternName: 'Validated Security Pattern',
          lifecycleState: 'validated',
          patternType: 'security',
        }),
        createMockPattern({
          patternName: 'Candidate Security Pattern',
          lifecycleState: 'candidate',
          patternType: 'security',
        }),
        createMockPattern({
          patternName: 'Validated Behavioral Pattern',
          lifecycleState: 'validated',
          patternType: 'behavioral',
        }),
        createMockPattern({
          patternName: 'Candidate Behavioral Pattern',
          lifecycleState: 'candidate',
          patternType: 'behavioral',
        }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Validated Security Pattern').length).toBeGreaterThan(0);
      });

      // Apply state filter: validated
      let comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[0]); // State
      await user.click(screen.getByRole('option', { name: /validated/i }));

      // Apply type filter: security
      comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[1]); // Type
      await user.click(screen.getByRole('option', { name: /security/i }));

      // Only patterns matching BOTH filters should be visible
      await waitFor(() => {
        expect(screen.getAllByText('Validated Security Pattern').length).toBeGreaterThan(0);
      });
      expect(screen.queryAllByText('Candidate Security Pattern')).toHaveLength(0);
      expect(screen.queryAllByText('Validated Behavioral Pattern')).toHaveLength(0);
      expect(screen.queryAllByText('Candidate Behavioral Pattern')).toHaveLength(0);

      // Both filter badges should be visible
      expect(screen.getByText('State: validated')).toBeInTheDocument();
      expect(screen.getByText('Type: security')).toBeInTheDocument();

      result.unmount();
    });

    it('combines state filter with search', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({
          patternName: 'Auth Handler',
          lifecycleState: 'validated',
        }),
        createMockPattern({
          patternName: 'Auth Validator',
          lifecycleState: 'candidate',
        }),
        createMockPattern({
          patternName: 'Retry Logic',
          lifecycleState: 'validated',
        }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Auth Handler').length).toBeGreaterThan(0);
      });

      // Apply state filter: validated
      const comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[0]);
      await user.click(screen.getByRole('option', { name: /validated/i }));

      // Apply search: Auth
      const searchInput = screen.getByPlaceholderText('Search patterns...');
      await user.type(searchInput, 'Auth');

      // Only validated + Auth patterns should be visible
      await waitFor(() => {
        expect(screen.getAllByText('Auth Handler').length).toBeGreaterThan(0);
      });
      expect(screen.queryAllByText('Auth Validator')).toHaveLength(0);
      expect(screen.queryAllByText('Retry Logic')).toHaveLength(0);

      result.unmount();
    });

    it('combines all three filter types', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({
          patternName: 'Auth Security Handler',
          lifecycleState: 'validated',
          patternType: 'security',
        }),
        createMockPattern({
          patternName: 'Auth Behavioral Handler',
          lifecycleState: 'validated',
          patternType: 'behavioral',
        }),
        createMockPattern({
          patternName: 'Retry Security Handler',
          lifecycleState: 'validated',
          patternType: 'security',
        }),
        createMockPattern({
          patternName: 'Auth Security Candidate',
          lifecycleState: 'candidate',
          patternType: 'security',
        }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Auth Security Handler').length).toBeGreaterThan(0);
      });

      // State: validated
      let comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[0]);
      await user.click(screen.getByRole('option', { name: /validated/i }));

      // Type: security
      comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[1]);
      await user.click(screen.getByRole('option', { name: /security/i }));

      // Search: Auth
      const searchInput = screen.getByPlaceholderText('Search patterns...');
      await user.type(searchInput, 'Auth');

      // Only the pattern matching all three should be visible
      await waitFor(() => {
        expect(screen.getAllByText('Auth Security Handler').length).toBeGreaterThan(0);
      });
      expect(screen.queryAllByText('Auth Behavioral Handler')).toHaveLength(0);
      expect(screen.queryAllByText('Retry Security Handler')).toHaveLength(0);
      expect(screen.queryAllByText('Auth Security Candidate')).toHaveLength(0);

      result.unmount();
    });
  });

  // ===========================
  // Limit Filter Tests
  // ===========================

  describe('Limit Filter', () => {
    it('limits displayed patterns based on limit selection', async () => {
      const user = userEvent.setup();

      // Create 30 patterns
      const patterns = Array.from({ length: 30 }, (_, i) =>
        createMockPattern({ patternName: `Pattern ${i + 1}` })
      );

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue(patterns);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Pattern 1').length).toBeGreaterThan(0);
      });

      // Default limit is 50, so all 30 should be visible
      expect(screen.getAllByText('Pattern 30').length).toBeGreaterThan(0);

      // Change limit to 25 (third combobox)
      const comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[2]); // Limit is third
      await user.click(screen.getByRole('option', { name: '25' }));

      // Now only 25 patterns should be visible in the main patterns table
      // (widget components may still render pattern names from the full filtered set)
      await waitFor(() => {
        const table = screen.getByTestId('patterns-table');
        expect(within(table).getAllByText('Pattern 25').length).toBeGreaterThan(0);
        expect(within(table).queryAllByText('Pattern 26')).toHaveLength(0);
      });

      result.unmount();
    });

    it('shows hidden count when limit is applied', async () => {
      const user = userEvent.setup();

      // Create 100 patterns
      const patterns = Array.from({ length: 100 }, (_, i) =>
        createMockPattern({ patternName: `Pattern ${i + 1}` })
      );

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue(patterns);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Pattern 1').length).toBeGreaterThan(0);
      });

      // Change limit to 25 (third combobox)
      const comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[2]);
      await user.click(screen.getByRole('option', { name: '25' }));

      // Description should show count (text format: "of X filtered")
      await waitFor(() => {
        const description = screen.getByText(/Showing 25 of 100 filtered/);
        expect(description).toBeInTheDocument();
      });

      result.unmount();
    });
  });

  // ===========================
  // Clear Filters Tests
  // ===========================

  describe('Clear Filters', () => {
    it('clears all filters when Clear button is clicked', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'Pattern A', lifecycleState: 'validated' }),
        createMockPattern({ patternName: 'Pattern B', lifecycleState: 'candidate' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Pattern A').length).toBeGreaterThan(0);
      });

      // Apply state filter
      const comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[0]);
      await user.click(screen.getByRole('option', { name: /validated/i }));

      // Apply search
      const searchInput = screen.getByPlaceholderText('Search patterns...');
      await user.type(searchInput, 'Pattern A');

      // Verify filters are applied
      await waitFor(() => {
        expect(screen.queryAllByText('Pattern B')).toHaveLength(0);
      });

      // Click Clear button
      const clearButton = screen.getByRole('button', { name: /clear/i });
      await user.click(clearButton);

      // All patterns should be visible again
      await waitFor(() => {
        expect(screen.getAllByText('Pattern A').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Pattern B').length).toBeGreaterThan(0);
      });

      // Filter badges should be gone
      expect(screen.queryByText('State: validated')).not.toBeInTheDocument();
      expect(screen.queryByText(/Search:/)).not.toBeInTheDocument();

      result.unmount();
    });

    it('shows filter badges when filters are applied', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({
          patternName: 'Validated Security',
          lifecycleState: 'validated',
          patternType: 'security',
        }),
        createMockPattern({
          patternName: 'Validated Behavioral',
          lifecycleState: 'validated',
          patternType: 'behavioral',
        }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Validated Security').length).toBeGreaterThan(0);
      });

      // No filter badges initially
      expect(screen.queryByText('State: validated')).not.toBeInTheDocument();
      expect(screen.queryByText('Type: security')).not.toBeInTheDocument();

      // Apply state filter
      let comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[0]);
      await user.click(screen.getByRole('option', { name: /validated/i }));

      // State badge appears
      await waitFor(() => {
        expect(screen.getByText('State: validated')).toBeInTheDocument();
      });

      // Apply type filter
      comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[1]);
      await user.click(screen.getByRole('option', { name: /security/i }));

      // Both badges visible
      await waitFor(() => {
        expect(screen.getByText('Type: security')).toBeInTheDocument();
      });
      expect(screen.getByText('State: validated')).toBeInTheDocument();

      // Only matching pattern visible
      expect(screen.getAllByText('Validated Security').length).toBeGreaterThan(0);
      expect(screen.queryAllByText('Validated Behavioral')).toHaveLength(0);

      result.unmount();
    });

    it('Clear button is only visible when filters are active', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([createMockPattern()]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getByTestId('page-pattern-learning')).toBeInTheDocument();
      });

      // Clear button should not be visible initially
      expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();

      // Apply a filter
      const searchInput = screen.getByPlaceholderText('Search patterns...');
      await user.type(searchInput, 'test');

      // Clear button should now be visible
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
      });

      result.unmount();
    });
  });

  // ===========================
  // Hidden Count Badge Tests
  // ===========================

  describe('Hidden Count Badge', () => {
    it('shows correct count of hidden patterns', async () => {
      const user = userEvent.setup();

      // Create 10 patterns, 3 validated
      const patterns = [
        createMockPattern({ patternName: 'Validated 1', lifecycleState: 'validated' }),
        createMockPattern({ patternName: 'Validated 2', lifecycleState: 'validated' }),
        createMockPattern({ patternName: 'Validated 3', lifecycleState: 'validated' }),
        createMockPattern({ patternName: 'Candidate 1', lifecycleState: 'candidate' }),
        createMockPattern({ patternName: 'Candidate 2', lifecycleState: 'candidate' }),
        createMockPattern({ patternName: 'Provisional 1', lifecycleState: 'provisional' }),
        createMockPattern({ patternName: 'Provisional 2', lifecycleState: 'provisional' }),
        createMockPattern({ patternName: 'Deprecated 1', lifecycleState: 'deprecated' }),
        createMockPattern({ patternName: 'Deprecated 2', lifecycleState: 'deprecated' }),
        createMockPattern({ patternName: 'Deprecated 3', lifecycleState: 'deprecated' }),
      ];

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue(patterns);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Validated 1').length).toBeGreaterThan(0);
      });

      // Apply state filter: validated
      const comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[0]);
      await user.click(screen.getByRole('option', { name: /validated/i }));

      // 7 patterns should be hidden (10 total - 3 validated)
      await waitFor(() => {
        expect(screen.getByText('7 hidden by filters')).toBeInTheDocument();
      });

      result.unmount();
    });

    it('hides the badge when no filters are active', async () => {
      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'Pattern 1' }),
        createMockPattern({ patternName: 'Pattern 2' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Pattern 1').length).toBeGreaterThan(0);
      });

      // No hidden badge should be present
      expect(screen.queryByText(/hidden by filters/)).not.toBeInTheDocument();

      result.unmount();
    });
  });

  // ===========================
  // Empty State Tests
  // ===========================

  describe('Empty States', () => {
    it('shows empty message when no patterns match filters', async () => {
      const user = userEvent.setup();

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'Pattern A', lifecycleState: 'validated' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Pattern A').length).toBeGreaterThan(0);
      });

      // Apply filter that matches nothing
      const comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[0]);
      await user.click(screen.getByRole('option', { name: /deprecated/i }));

      // Should show empty message
      await waitFor(() => {
        expect(screen.getByText('No patterns match the current filters.')).toBeInTheDocument();
      });

      result.unmount();
    });

    it('shows different message when no patterns exist at all', async () => {
      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getByText('No patterns found.')).toBeInTheDocument();
      });

      result.unmount();
    });
  });

  // ===========================
  // Error State Tests
  // ===========================

  describe('Error States', () => {
    it('shows error message when pattern list fails to load', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockRejectedValue(new Error('Network error'));

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      // "Failed to load patterns" appears in multiple components (Patterns table + TopPatternsTable)
      await waitFor(() => {
        expect(screen.getAllByText('Failed to load patterns').length).toBeGreaterThan(0);
      });

      consoleError.mockRestore();
      result.unmount();
    });

    it('shows error message when summary fails to load', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.mocked(patlearnSource.summary).mockRejectedValue(new Error('API error'));
      vi.mocked(patlearnSource.list).mockResolvedValue([createMockPattern()]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getByText('Failed to load summary data')).toBeInTheDocument();
      });

      consoleError.mockRestore();
      result.unmount();
    });
  });

  // ===========================
  // URL Parameter Sync Tests
  // ===========================

  describe('URL Parameter Sync', () => {
    it('initializes filter state from URL params', async () => {
      // Set up URL params before render
      mockSearchParams({ state: 'validated', type: 'security', search: 'auth' });

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({
          patternName: 'Auth Handler',
          patternType: 'security',
          lifecycleState: 'validated',
        }),
        createMockPattern({
          patternName: 'Other Pattern',
          patternType: 'behavioral',
          lifecycleState: 'candidate',
        }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      // Wait for render and verify filter badges are shown
      await waitFor(() => {
        expect(screen.getByText('State: validated')).toBeInTheDocument();
      });
      expect(screen.getByText('Type: security')).toBeInTheDocument();
      expect(screen.getByText('Search: "auth"')).toBeInTheDocument();

      result.unmount();
    });

    it('initializes limit from URL params', async () => {
      mockSearchParams({ limit: '100' });

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([createMockPattern()]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        // The limit dropdown should show 100
        const limitSelect = screen.getAllByRole('combobox')[2]; // 3rd combobox is limit
        expect(limitSelect).toHaveTextContent('100');
      });

      result.unmount();
    });

    it('falls back to defaults for invalid URL params', async () => {
      // Invalid state and limit values
      mockSearchParams({ state: 'invalid_state', limit: '999' });

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([createMockPattern()]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        // No state filter badge should be shown (invalid state ignored)
        expect(screen.queryByText(/State:/)).not.toBeInTheDocument();
      });

      // Limit should default to 50
      const limitSelect = screen.getAllByRole('combobox')[2];
      expect(limitSelect).toHaveTextContent('50');

      result.unmount();
    });

    it('sanitizes search param to prevent XSS', async () => {
      // Try to inject HTML tags - they should be stripped
      mockSearchParams({ search: '<b>bold</b>' });

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([createMockPattern()]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        // The HTML tags should be stripped, keeping only the text content
        expect(screen.getByText('Search: "bold"')).toBeInTheDocument();
      });

      // Verify no HTML tags rendered in the search badge
      const searchBadge = screen.getByText('Search: "bold"');
      expect(searchBadge.innerHTML).not.toContain('<b>');
      expect(searchBadge.innerHTML).not.toContain('</b>');

      result.unmount();
    });

    it('syncs filter changes to URL', async () => {
      const user = userEvent.setup();
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'Test Pattern', lifecycleState: 'validated' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getAllByText('Test Pattern').length).toBeGreaterThan(0);
      });

      // Apply state filter
      const comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[0]);
      await user.click(screen.getByRole('option', { name: /validated/i }));

      // Verify replaceState was called with the filter params
      await waitFor(() => {
        expect(replaceStateSpy).toHaveBeenCalledWith(
          {},
          '',
          expect.stringContaining('state=validated')
        );
      });

      replaceStateSpy.mockRestore();
      result.unmount();
    });

    it('clears URL params when filters are cleared', async () => {
      const user = userEvent.setup();
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      // Start with a filter applied
      mockSearchParams({ state: 'validated' });

      vi.mocked(patlearnSource.summary).mockResolvedValue(createMockSummary());
      vi.mocked(patlearnSource.list).mockResolvedValue([
        createMockPattern({ patternName: 'Test Pattern', lifecycleState: 'validated' }),
      ]);

      const result = renderWithClient(<PatternLearning />);
      queryClient = result.queryClient;

      await waitFor(() => {
        expect(screen.getByText('State: validated')).toBeInTheDocument();
      });

      // Click the Clear button
      const clearButton = screen.getByRole('button', { name: /clear/i });
      await user.click(clearButton);

      // Verify URL is cleared (pathname only, no query string)
      await waitFor(() => {
        expect(replaceStateSpy).toHaveBeenCalledWith({}, '', expect.not.stringContaining('?'));
      });

      replaceStateSpy.mockRestore();
      result.unmount();
    });
  });
});
