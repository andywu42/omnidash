/**
 * Projection handler registry (OMN-5192).
 *
 * Exports all projection handlers and the shared types used by the
 * read-model consumer orchestrator.
 */

export type {
  ProjectionHandler,
  ProjectionContext,
  MessageMeta,
  ProjectionHandlerStats,
  DropReason,
} from './types';
export {
  deterministicCorrelationId,
  sanitizeSessionId,
  safeParseDate,
  safeParseDateOrMin,
  isTableMissingError,
  UUID_RE,
  MAX_BATCH_ROWS,
  VALID_PROMOTION_ACTIONS,
  VALID_CONFIDENCE_LEVELS,
  createHandlerStats,
  registerHandlerStats,
  getAllHandlerStats,
} from './types';

export { OmniclaudeProjectionHandler } from './omniclaude-projections';
export { DodProjectionHandler } from './dod-projections';
export { OmniintelligenceProjectionHandler } from './omniintelligence-projections';
export { OmnibaseInfraProjectionHandler } from './omnibase-infra-projections';
export { PlatformProjectionHandler } from './platform-projections';
export { OmniMemoryProjectionHandler } from './omnimemory-projections';
export { ChangeControlProjectionHandler } from './change-control-projections';
export { EvalProjectionHandler } from './eval-projections';
export { OmnimarketProjectionHandler } from './omnimarket-projections';
export { BloomEvalProjectionHandler } from './bloom-eval-projections';
export { SweepProjectionHandler } from './sweep-projections';

import type { ProjectionHandler } from './types';
import { OmniclaudeProjectionHandler } from './omniclaude-projections';
import { DodProjectionHandler } from './dod-projections';
import { OmniintelligenceProjectionHandler } from './omniintelligence-projections';
import { OmnibaseInfraProjectionHandler } from './omnibase-infra-projections';
import { PlatformProjectionHandler } from './platform-projections';
import { OmniMemoryProjectionHandler } from './omnimemory-projections';
import { ChangeControlProjectionHandler } from './change-control-projections';
import { EvalProjectionHandler } from './eval-projections';
import { OmnimarketProjectionHandler } from './omnimarket-projections';
import { BloomEvalProjectionHandler } from './bloom-eval-projections';
import { SweepProjectionHandler } from './sweep-projections';

/**
 * Create the ordered list of all projection handlers.
 *
 * The order matters only for the first-match short circuit in the
 * orchestrator's dispatch loop. Placing the highest-traffic handler
 * (omniclaude) first minimises unnecessary canHandle() calls.
 */
export function createProjectionHandlers(): ProjectionHandler[] {
  return [
    new OmniclaudeProjectionHandler(),
    new DodProjectionHandler(),
    new OmniintelligenceProjectionHandler(),
    new OmnibaseInfraProjectionHandler(),
    new PlatformProjectionHandler(),
    new OmniMemoryProjectionHandler(),
    new ChangeControlProjectionHandler(),
    new EvalProjectionHandler(),
    new OmnimarketProjectionHandler(),
    new BloomEvalProjectionHandler(),
    new SweepProjectionHandler(),
  ];
}
