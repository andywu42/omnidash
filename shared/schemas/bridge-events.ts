/**
 * Zod schemas for bridge event payloads emitted by canonical handlers
 * in event-consumer.ts and consumed by node-registry-projection.ts.
 *
 * These schemas validate the shape of events at the emit boundary to
 * prevent silent divergence between emitter and consumer. Validation
 * is defensive: warns on schema violations but does not crash.
 *
 * Field naming: snake_case is canonical (matches Kafka wire format from
 * the Python runtime). See OMN-5161 for the normalization rationale.
 *
 * OMN-5163
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Bridge event schemas (snake_case canonical)
// ---------------------------------------------------------------------------

export const BridgeNodeIntrospectionSchema = z.object({
  node_id: z.string(),
  node_type: z.string().optional(),
  version: z.string().optional(),
  current_state: z.string().nullable().optional(),
  capabilities: z.unknown().optional(),
  metadata: z.record(z.unknown()).optional(),
  endpoints: z.record(z.unknown()).optional(),
  reason: z.string().nullable().optional(),
  event_bus: z.record(z.unknown()).nullable().optional(),
  emitted_at: z.string().optional(),
  // Top-level fields threaded from canonical introspection payload (OMN-6405)
  description: z.string().optional(),
  node_name: z.string().optional(),
});

export const BridgeNodeHeartbeatSchema = z.object({
  id: z.string().optional(),
  nodeId: z.string(), // Legacy heartbeat events use camelCase
  uptimeSeconds: z.number().optional(),
  activeOperationsCount: z.number().optional(),
  memoryUsageMb: z.number().optional(),
  cpuUsagePercent: z.number().optional(),
  createdAt: z.date().or(z.string()).optional(),
});

export const BridgeNodeStateChangeSchema = z.object({
  node_id: z.string(),
  new_state: z.string(),
  previous_state: z.string().nullable().optional(),
  emitted_at: z.string().optional(),
});

export const BridgeNodeBecameActiveSchema = z.object({
  node_id: z.string(),
  capabilities: z.unknown().nullable().optional(),
  emitted_at: z.string().optional(),
});

export const BridgeNodeRegistryUpdateSchema = z.array(z.record(z.unknown()));

// ---------------------------------------------------------------------------
// Validation helper (defensive — warns, does not crash)
// ---------------------------------------------------------------------------

/**
 * Validate an event payload against a Zod schema at the emit boundary.
 * Logs a warning on validation failure but returns the data as-is so the
 * emit is not blocked. This catches structural drift early without
 * breaking the event pipeline.
 *
 * @returns The validated data on success, or the raw data with a warning on failure.
 */
export function validateBridgeEmit<T>(schema: z.ZodType<T>, data: unknown, eventName: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'bridge_emit_schema_violation',
        eventName,
        errors: result.error.issues,
      })
    );
    // Return data as-is — defensive mode, do not block the emit
    return data as T;
  }
  return result.data;
}
