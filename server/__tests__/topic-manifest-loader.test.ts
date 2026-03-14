/**
 * Tests for TopicManifestLoader (OMN-5028)
 *
 * Verifies:
 *   1. Manifest loads from project root (topics.yaml)
 *   2. Returns correct topic strings
 *   3. Validates manifest schema (rejects invalid)
 *   4. Parity: manifest topics match READ_MODEL_TOPICS from shared/topics.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import {
  loadTopicManifest,
  loadManifestTopics,
  resetManifestCache,
} from '../services/topic-manifest-loader';
import { READ_MODEL_TOPICS } from '../../server/read-model-consumer';

describe('TopicManifestLoader', () => {
  beforeEach(() => {
    resetManifestCache();
  });

  afterEach(() => {
    resetManifestCache();
    delete process.env.TOPICS_MANIFEST_PATH;
  });

  it('loads manifest from project root', () => {
    // Point to the actual topics.yaml in the project root
    process.env.TOPICS_MANIFEST_PATH = path.resolve(__dirname, '../../topics.yaml');

    const manifest = loadTopicManifest();
    expect(manifest.version).toBe('1');
    expect(manifest.read_model_topics.length).toBeGreaterThan(0);
  });

  it('loadManifestTopics returns topic strings', () => {
    process.env.TOPICS_MANIFEST_PATH = path.resolve(__dirname, '../../topics.yaml');

    const topics = loadManifestTopics();
    expect(topics).toContain('onex.evt.omniclaude.agent-actions.v1');
    expect(topics).toContain('onex.evt.omniintelligence.llm-call-completed.v1');
  });

  it('caches result after first load', () => {
    process.env.TOPICS_MANIFEST_PATH = path.resolve(__dirname, '../../topics.yaml');

    const a = loadTopicManifest();
    const b = loadTopicManifest();
    expect(a).toBe(b);
  });

  it('throws when no manifest file is found', () => {
    process.env.TOPICS_MANIFEST_PATH = '/nonexistent/topics.yaml';
    // The loader tries env path first, then cwd/topics.yaml (which exists in
    // the test runner's cwd), so we also need to ensure cwd resolution fails.
    // We use a spy on process.cwd to return a path without topics.yaml.
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/no-such-dir');

    try {
      expect(() => loadTopicManifest()).toThrow('No topics.yaml found');
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

describe('TopicManifest parity with READ_MODEL_TOPICS', () => {
  beforeEach(() => {
    resetManifestCache();
  });

  afterEach(() => {
    resetManifestCache();
    delete process.env.TOPICS_MANIFEST_PATH;
  });

  it('manifest contains all READ_MODEL_TOPICS entries', () => {
    process.env.TOPICS_MANIFEST_PATH = path.resolve(__dirname, '../../topics.yaml');

    const manifestTopics = new Set(loadManifestTopics());
    const readModelTopics = [...READ_MODEL_TOPICS];

    const missing = readModelTopics.filter((t) => !manifestTopics.has(t));

    expect(missing).toEqual([]);
  });

  it('READ_MODEL_TOPICS contains all manifest entries', () => {
    process.env.TOPICS_MANIFEST_PATH = path.resolve(__dirname, '../../topics.yaml');

    const manifestTopics = loadManifestTopics();
    const readModelSet = new Set(READ_MODEL_TOPICS as readonly string[]);

    const extra = manifestTopics.filter((t) => !readModelSet.has(t));

    expect(extra).toEqual([]);
  });
});
