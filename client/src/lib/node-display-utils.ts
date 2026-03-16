/** ONEX node IDs are snake_case slugs; UUIDs get truncated. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Derive a human-readable display name from a node ID.
 *
 * This is a presentation-layer heuristic, not a canonical naming system.
 * Snake_case slugs become title-cased words; UUIDs are truncated.
 */
export function deriveNodeName(nodeId: string): string {
  if (UUID_RE.test(nodeId)) return nodeId.slice(0, 8) + '\u2026';
  const base = nodeId.replace(/^node_/, '');
  return base
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
