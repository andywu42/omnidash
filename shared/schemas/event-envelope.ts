import { z } from 'zod';

// ONEX Event Envelope (wraps all Kafka events)
//
// Canonical field names (from omnibase_core ModelEventEnvelope):
//   envelope_id         — unique envelope identifier (UUID)
//   envelope_timestamp  — envelope creation timestamp (ISO-8601 UTC)
//
// The dual naming convention (entity_id / emitted_at vs envelope_id /
// envelope_timestamp) has been resolved: `envelope_id` and
// `envelope_timestamp` are the authoritative names.  This schema accepts
// legacy `entity_id` / `emitted_at` during transition and normalises them
// to the canonical names so all consumers see a single shape.
const RawEventEnvelopeSchema = z
  .object({
    // Canonical: envelope_id (legacy alias: entity_id)
    envelope_id: z.string().uuid().optional(),
    entity_id: z.string().uuid().optional(),
    correlation_id: z.string().uuid(),
    causation_id: z.string().uuid().optional(),
    // Canonical: envelope_timestamp (legacy alias: emitted_at)
    envelope_timestamp: z.string().datetime().optional(),
    emitted_at: z.string().datetime().optional(),
    payload: z.unknown(),
  })
  .refine((data) => Boolean(data.envelope_id || data.entity_id), {
    message: 'envelope_id is required (legacy alias entity_id also accepted)',
  })
  .refine((data) => Boolean(data.envelope_timestamp || data.emitted_at), {
    message: 'envelope_timestamp is required (legacy alias emitted_at also accepted)',
  });

export const EventEnvelopeSchema = RawEventEnvelopeSchema.transform((data) => ({
  envelope_id: (data.envelope_id || data.entity_id)!,
  correlation_id: data.correlation_id,
  causation_id: data.causation_id,
  envelope_timestamp: (data.envelope_timestamp || data.emitted_at)!,
  payload: data.payload,
}));

export type EventEnvelope<T> = {
  envelope_id: string;
  correlation_id: string;
  causation_id?: string;
  envelope_timestamp: string;
  payload: T;
};

// ---------------------------------------------------------------------------
// Compat helpers for raw (pre-parse) event envelopes (OMN-3250)
//
// DO NOT access envelope_id / envelope_timestamp / entity_id / emitted_at
// fields directly on raw event objects — always use these helpers.
//
// They resolve the canonical name first; if only the legacy alias is present
// they emit a structured-log warn so telemetry can confirm zero legacy usage
// before OMN-3553 removes the aliases.
// ---------------------------------------------------------------------------

/**
 * Raw envelope shape that may carry either the canonical names or the legacy
 * aliases (or both). Do not use this type for post-parse envelopes.
 */
export interface RawEventEnvelope {
  // Canonical (match Python omnibase_core ModelEventEnvelope)
  envelope_id?: string;
  envelope_timestamp?: string;
  // Legacy — will be removed after OMN-3553 expiry condition (7-day zero usage)
  entity_id?: string;
  emitted_at?: string;
}

/**
 * Return the envelope identifier from a raw event, preferring the canonical
 * `envelope_id` field and falling back to the legacy `entity_id` alias.
 *
 * Emits a structured WARN log when the legacy alias is the only value
 * present, enabling telemetry tracking for OMN-3553 expiry.
 */
export function getEnvelopeId(evt: RawEventEnvelope): string | undefined {
  if (evt.envelope_id) return evt.envelope_id;
  if (evt.entity_id) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'legacy_envelope_field_used',
        field: 'entity_id',
        ticket: 'OMN-3553',
      })
    );
    return evt.entity_id;
  }
  return undefined;
}

/**
 * Return the envelope timestamp from a raw event, preferring the canonical
 * `envelope_timestamp` field and falling back to the legacy `emitted_at` alias.
 *
 * Emits a structured WARN log when the legacy alias is the only value
 * present, enabling telemetry tracking for OMN-3553 expiry.
 */
export function getEnvelopeTimestamp(evt: RawEventEnvelope): string | undefined {
  if (evt.envelope_timestamp) return evt.envelope_timestamp;
  if (evt.emitted_at) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'legacy_envelope_field_used',
        field: 'emitted_at',
        ticket: 'OMN-3553',
      })
    );
    return evt.emitted_at;
  }
  return undefined;
}

// Node capabilities - generic, not hardcoded flags
export const NodeCapabilitiesSchema = z.record(z.string(), z.unknown());
export type NodeCapabilities = z.infer<typeof NodeCapabilitiesSchema>;

// node-became-active payload
export const NodeBecameActivePayloadSchema = z.object({
  node_id: z.string().uuid(),
  capabilities: NodeCapabilitiesSchema,
});
export type NodeBecameActivePayload = z.infer<typeof NodeBecameActivePayloadSchema>;

// node-heartbeat payload
export const NodeHeartbeatPayloadSchema = z.object({
  node_id: z.string().uuid(),
  uptime_seconds: z.number().optional(),
  memory_usage_mb: z.number().optional(),
  cpu_usage_percent: z.number().optional(),
  active_operations_count: z.number().optional(),
});
export type NodeHeartbeatPayload = z.infer<typeof NodeHeartbeatPayloadSchema>;

// node-liveness-expired payload
export const NodeLivenessExpiredPayloadSchema = z.object({
  node_id: z.string().uuid(),
  last_heartbeat_at: z.string().datetime().nullable(),
});
export type NodeLivenessExpiredPayload = z.infer<typeof NodeLivenessExpiredPayloadSchema>;

// node-introspection payload
// node_version may arrive as a plain semver string or as a Python ModelSemVer
// object { major, minor, patch } — accept both shapes (OMN-4098).
export const NodeIntrospectionPayloadSchema = z.object({
  node_id: z.string().uuid(),
  node_type: z.string().optional(),
  node_version: z
    .union([
      z.string(),
      z.object({
        major: z.number(),
        minor: z.number(),
        patch: z.number(),
      }),
    ])
    .optional(),
  capabilities: NodeCapabilitiesSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  current_state: z.string().nullable().optional(),
});
export type NodeIntrospectionPayload = z.infer<typeof NodeIntrospectionPayloadSchema>;
