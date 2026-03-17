/**
 * Topic Topology API Routes (OMN-5294)
 *
 * Parses topics.yaml and returns a graph representation of:
 * - Service nodes (producers inferred from topic name: onex.<kind>.<producer>.<event>.<ver>)
 * - Topic edges connecting producers to the dashboard consumer
 *
 * Routes:
 *   GET /api/topology
 *     Returns:
 *       {
 *         nodes: { id: string; label: string; topicCount: number }[],
 *         edges: { id: string; source: string; target: string; topic: string; handler: string }[],
 *         totalTopics: number
 *       }
 */

import { Router } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

interface TopicEntry {
  topic: string;
  handler: string;
}

interface TopicsYaml {
  version: string;
  read_model_topics: TopicEntry[];
}

interface TopologyNode {
  id: string;
  label: string;
  topicCount: number;
}

interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  topic: string;
  handler: string;
}

interface TopologyResponse {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  totalTopics: number;
}

/**
 * Extracts the producer segment from an ONEX canonical topic name.
 * Format: onex.<kind>.<producer>.<event-name>.<version>
 * e.g. "onex.evt.omniclaude.gate-decision.v1" → "omniclaude"
 */
function extractProducer(topic: string): string {
  const parts = topic.split('.');
  // parts[0]=onex, parts[1]=kind (evt/cmd), parts[2]=producer
  if (parts.length >= 3) {
    return parts[2];
  }
  return 'unknown';
}

const router = Router();

router.get('/', (_req, res) => {
  try {
    const topicsYamlPath = join(process.cwd(), 'topics.yaml');
    const raw = readFileSync(topicsYamlPath, 'utf8');
    const data = yaml.load(raw) as TopicsYaml;

    const entries: TopicEntry[] = data?.read_model_topics ?? [];

    // Deduplicate topics by name (topics.yaml has some duplicate entries)
    const seen = new Set<string>();
    const unique = entries.filter((e) => {
      if (seen.has(e.topic)) return false;
      seen.add(e.topic);
      return true;
    });

    // Build producer → topic count map
    const producerCounts = new Map<string, number>();
    for (const entry of unique) {
      const producer = extractProducer(entry.topic);
      producerCounts.set(producer, (producerCounts.get(producer) ?? 0) + 1);
    }

    // Nodes: one per producer + one dashboard sink node
    const DASHBOARD_NODE_ID = 'omnidash';
    const nodes: TopologyNode[] = [
      { id: DASHBOARD_NODE_ID, label: 'omnidash', topicCount: unique.length },
      ...Array.from(producerCounts.entries()).map(([id, count]) => ({
        id,
        label: id,
        topicCount: count,
      })),
    ];

    // Edges: one per unique topic
    const edges: TopologyEdge[] = unique.map((entry, idx) => ({
      id: `edge-${idx}`,
      source: extractProducer(entry.topic),
      target: DASHBOARD_NODE_ID,
      topic: entry.topic,
      handler: entry.handler,
    }));

    const response: TopologyResponse = {
      nodes,
      edges,
      totalTopics: unique.length,
    };

    res.json(response);
  } catch (err) {
    console.error('[TopologyRoutes] Error building topology:', err);
    res.status(500).json({ error: String(err) });
  }
});

export default router;
