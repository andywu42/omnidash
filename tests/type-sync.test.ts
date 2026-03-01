/**
 * CI Assertion: TypeScript ↔ Python Type Sync (OMN-3258)
 *
 * Verifies that the TypeScript boundary types in shared/ contain the required
 * field names that correspond to Python Pydantic model fields in omnibase_core
 * and omniintelligence.
 *
 * This test catches the class of failure where a Python model field is renamed
 * (e.g. `envelope_id` → `id`) without updating the TypeScript consumer type,
 * causing silent deserialization failures at runtime.
 *
 * Approach:
 *   Static analysis — reads TypeScript files as text and checks for required
 *   field name identifiers. No runtime Kafka or Python imports needed.
 *
 * What this test does NOT do:
 *   - It does not run the Python check script (that is done by the CI workflow)
 *   - It does not validate every Python field (only the required boundary fields)
 *   - It does not validate TypeScript type correctness (that is npm run check)
 *
 * Root cause this prevents:
 *   Rename `envelope_id` in ModelEventEnvelope → consumers silently receive
 *   undefined. This test would have caught that in CI before merge.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SHARED_DIR = path.resolve(__dirname, '..', 'shared');

// ---------------------------------------------------------------------------
// Required field name mappings
//
// These mirror the TARGETS list in scripts/check_type_sync.py.
// The fields listed here are the minimal required boundary fields that MUST
// appear in each TypeScript file. They must be kept in sync with the Python
// model fields they represent.
// ---------------------------------------------------------------------------

interface FieldRequirement {
  description: string;
  tsFile: string;
  requiredFields: string[];
}

const FIELD_REQUIREMENTS: FieldRequirement[] = [
  {
    description: 'ModelEventEnvelope core boundary fields',
    tsFile: path.join(SHARED_DIR, 'schemas', 'event-envelope.ts'),
    requiredFields: [
      'envelope_id', // ModelEventEnvelope.envelope_id (unique identifier)
      'correlation_id', // ModelEventEnvelope.correlation_id (tracing)
      'envelope_timestamp', // ModelEventEnvelope.envelope_timestamp (creation time)
      'payload', // ModelEventEnvelope.payload (event data)
    ],
  },
  {
    description: 'ModelIntentClassifiedEvent core boundary fields',
    tsFile: path.join(SHARED_DIR, 'intent-types.ts'),
    requiredFields: [
      'event_type', // ModelIntentClassifiedEvent.event_type
      'session_id', // ModelIntentClassifiedEvent.session_id
      'correlation_id', // ModelIntentClassifiedEvent.correlation_id
      'confidence', // ModelIntentClassifiedEvent.confidence
    ],
  },
  {
    description: 'NodeHeartbeat payload core fields',
    tsFile: path.join(SHARED_DIR, 'schemas', 'event-envelope.ts'),
    requiredFields: [
      'node_id', // NodeHeartbeatPayload.node_id
      'uptime_seconds', // NodeHeartbeatPayload.uptime_seconds (optional but declared)
    ],
  },
];

// ---------------------------------------------------------------------------
// Helper: check that a field name appears as an identifier in TS source
// ---------------------------------------------------------------------------

function fieldPresentInSource(field: string, source: string): boolean {
  // Use word-boundary regex to avoid partial matches
  const pattern = new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return pattern.test(source);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TypeScript ↔ Python Type Sync (OMN-3258)', () => {
  for (const req of FIELD_REQUIREMENTS) {
    describe(req.description, () => {
      let source: string;

      let readError: Error | null = null;
      try {
        source = fs.readFileSync(req.tsFile, 'utf-8');
      } catch (err) {
        readError = err as Error;
        source = '';
      }

      it(`should be readable: ${path.relative(SHARED_DIR, req.tsFile)}`, () => {
        expect(readError).toBeNull();
      });

      for (const field of req.requiredFields) {
        it(`should contain field: ${field}`, () => {
          expect(fieldPresentInSource(field, source)).toBe(true);
        });
      }
    });
  }

  // Sanity check: the test file itself has not been emptied
  it('should have field requirements defined', () => {
    expect(FIELD_REQUIREMENTS.length).toBeGreaterThan(0);
    const totalFields = FIELD_REQUIREMENTS.reduce((sum, req) => sum + req.requiredFields.length, 0);
    expect(totalFields).toBeGreaterThan(0);
  });
});
