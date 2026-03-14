/**
 * TopicManifestLoader (OMN-5028)
 *
 * Loads the contract-first topics.yaml manifest that defines which topics
 * the ReadModelConsumer subscribes to. Supports multi-path resolution:
 *
 *   1. TOPICS_MANIFEST_PATH env var (explicit override)
 *   2. ./topics.yaml (project root — local dev)
 *   3. /app/topics.yaml (Docker container default)
 *
 * The manifest is loaded once at startup and cached for the lifetime of
 * the process.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TopicManifestEntrySchema = z.object({
  topic: z.string(),
  handler: z.string().optional(),
});

const TopicManifestSchema = z.object({
  version: z.string(),
  read_model_topics: z.array(TopicManifestEntrySchema),
});

export type TopicManifestEntry = z.infer<typeof TopicManifestEntrySchema>;
export type TopicManifest = z.infer<typeof TopicManifestSchema>;

// ---------------------------------------------------------------------------
// Resolution paths
// ---------------------------------------------------------------------------

function getResolutionPaths(): string[] {
  const paths: string[] = [];

  // 1. Explicit env var override
  const envPath = process.env.TOPICS_MANIFEST_PATH;
  if (envPath) {
    paths.push(envPath);
  }

  // 2. Project root (local dev) — relative to cwd
  paths.push(path.resolve(process.cwd(), 'topics.yaml'));

  // 3. Docker container default
  paths.push('/app/topics.yaml');

  return paths;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let _cached: TopicManifest | null = null;
let _resolvedPath: string | null = null;

/**
 * Load the topic manifest, trying resolution paths in order.
 * Caches the result after first successful load.
 *
 * @throws Error if no manifest file is found at any resolution path,
 *         or if the manifest fails Zod validation.
 */
export function loadTopicManifest(): TopicManifest {
  if (_cached) return _cached;

  const paths = getResolutionPaths();

  for (const p of paths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = yaml.load(raw);
      const validated = TopicManifestSchema.parse(parsed);

      _cached = validated;
      _resolvedPath = p;

      console.log(
        `[topic-manifest-loader] Loaded ${validated.read_model_topics.length} topics from ${p}`
      );

      return validated;
    }
  }

  throw new Error(`[topic-manifest-loader] No topics.yaml found. Searched: ${paths.join(', ')}`);
}

/**
 * Get just the topic strings from the manifest (convenience helper).
 */
export function loadManifestTopics(): string[] {
  const manifest = loadTopicManifest();
  return manifest.read_model_topics.map((entry) => entry.topic);
}

/**
 * Get the resolved path of the loaded manifest (for diagnostics).
 */
export function getManifestPath(): string | null {
  return _resolvedPath;
}

/**
 * Reset the cached manifest (for testing).
 */
export function resetManifestCache(): void {
  _cached = null;
  _resolvedPath = null;
}
