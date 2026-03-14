/**
 * TopicDiscoveryCoordinator (OMN-5026)
 *
 * Coordinates the two-phase consumer startup for EventConsumer:
 *
 *   Phase 1: Subscribe to BOOTSTRAP_TOPICS (control-plane only)
 *   Phase 2: Wait for TopicRegistryService to stabilize via debounce,
 *            then return the full topic set (BOOTSTRAP_TOPICS + registry topics)
 *
 * BOOTSTRAP_TOPICS are the 3 protocol-level control-plane topics that must
 * always be subscribed to, regardless of registry state:
 *   - node-introspection (how we discover topics)
 *   - node-registration (how we track node lifecycle)
 *   - request-introspection (how we ask nodes to re-introspect)
 *
 * Discovery uses a debounce + timeout model:
 *   - After each topicsChanged event, reset a debounce timer (default 15s)
 *   - If no new topics arrive for the debounce period, stabilize
 *   - If total time exceeds timeout (default 60s), stabilize with what we have
 *   - Timeout results in degraded health, but NOT a k8s readiness gate failure
 */

import type { TopicRegistryService } from './topic-registry-service';
import {
  SUFFIX_NODE_INTROSPECTION,
  SUFFIX_NODE_REGISTRATION,
  SUFFIX_REQUEST_INTROSPECTION,
} from '@shared/topics';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Protocol-level control-plane topics. These are always subscribed to,
 * regardless of discovery state. They are how omnidash discovers what
 * other topics exist.
 */
export const BOOTSTRAP_TOPICS = [
  SUFFIX_NODE_INTROSPECTION,
  SUFFIX_NODE_REGISTRATION,
  SUFFIX_REQUEST_INTROSPECTION,
] as const;

const DEFAULT_DEBOUNCE_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveryResult {
  /** Full topic list: BOOTSTRAP_TOPICS + registry-discovered topics */
  topics: string[];
  /** Where the topic list came from */
  source: 'registry' | 'bootstrap';
  /** True if discovery timed out before stabilizing */
  degraded: boolean;
  /** Number of unique evt topics discovered from registry */
  registryTopicCount: number;
  /** Number of nodes that reported event_bus data */
  nodeCount: number;
  /** How long discovery took (ms) */
  durationMs: number;
}

export interface DiscoveryCoordinatorOptions {
  /** Debounce period in ms (default 15000) */
  debounceMs?: number;
  /** Total timeout in ms (default 60000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export class TopicDiscoveryCoordinator {
  private debounceMs: number;
  private timeoutMs: number;

  constructor(
    private registry: TopicRegistryService,
    options?: DiscoveryCoordinatorOptions
  ) {
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Get the bootstrap topics (always subscribed).
   */
  getBootstrapTopics(): string[] {
    return [...BOOTSTRAP_TOPICS];
  }

  /**
   * Wait for topic discovery to stabilize, then return the full topic set.
   *
   * Returns immediately if the registry already has topics and no changes
   * are arriving. Otherwise waits up to timeoutMs for the debounce to
   * settle.
   *
   * The returned topic list is BOOTSTRAP_TOPICS union with all discovered
   * evt topics, deduplicated.
   */
  async waitForDiscovery(): Promise<DiscoveryResult> {
    const startMs = Date.now();

    // If registry already has topics and is presumably stable (e.g., resume),
    // do a quick check — wait one debounce period for changes
    const hasExistingTopics = this.registry.getAllEvtTopics().length > 0;

    return new Promise<DiscoveryResult>((resolve) => {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let resolved = false;

      const cleanup = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.registry.removeListener('topicsChanged', onTopicsChanged);
      };

      const stabilize = (degraded: boolean) => {
        if (resolved) return;
        resolved = true;
        cleanup();

        const registryTopics = this.registry.getAllEvtTopics();
        const allTopics = this.mergeTopics(registryTopics);

        resolve({
          topics: allTopics,
          source: registryTopics.length > 0 ? 'registry' : 'bootstrap',
          degraded,
          registryTopicCount: registryTopics.length,
          nodeCount: this.registry.getNodeCount(),
          durationMs: Date.now() - startMs,
        });
      };

      const resetDebounce = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          // Debounce period elapsed with no new changes — stabilize
          stabilize(false);
        }, this.debounceMs);
      };

      const onTopicsChanged = () => {
        resetDebounce();
      };

      // Listen for topic changes
      this.registry.on('topicsChanged', onTopicsChanged);

      // Set total timeout
      timeoutTimer = setTimeout(() => {
        console.warn(
          `[TopicDiscoveryCoordinator] Discovery timed out after ${this.timeoutMs}ms — ` +
            `proceeding with ${this.registry.getAllEvtTopics().length} discovered topics (degraded)`
        );
        stabilize(true);
      }, this.timeoutMs);

      // Start the initial debounce
      // If we already have topics, use a shorter initial debounce (1/3 of normal)
      // to avoid unnecessarily waiting when resuming with warm state
      if (hasExistingTopics) {
        debounceTimer = setTimeout(
          () => {
            stabilize(false);
          },
          Math.min(this.debounceMs / 3, 5000)
        );
      } else {
        resetDebounce();
      }
    });
  }

  /**
   * Get the current topic set without waiting for stabilization.
   * Useful for health probes that want a snapshot.
   */
  getCurrentTopics(): string[] {
    return this.mergeTopics(this.registry.getAllEvtTopics());
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Merge BOOTSTRAP_TOPICS with registry-discovered topics, deduplicated.
   */
  private mergeTopics(registryTopics: string[]): string[] {
    const set = new Set<string>([...BOOTSTRAP_TOPICS, ...registryTopics]);
    return [...set].sort();
  }
}
