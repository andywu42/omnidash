import { Kafka, Producer, Consumer } from 'kafkajs';
import { randomUUID } from 'crypto';
import {
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_CMD,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_COMPLETED,
  SUFFIX_INTELLIGENCE_CODE_ANALYSIS_FAILED,
} from '@shared/topics';

/**
 * Payload type for `IntelligenceEventAdapter.request()`.
 *
 * This is `Record<string, unknown>` — any string key is accepted at compile
 * time. There is no `Omit<...>` restriction on the type: TypeScript cannot
 * remove specific string-literal keys from a broad index signature, so such
 * an `Omit` would resolve to `Record<string, unknown>` anyway and provide no
 * compile-time enforcement. Reserved-key semantics are enforced entirely at
 * runtime (see the `reservedKeys` loop inside `request()`).
 *
 * Reserved envelope keys (`event_id`, `event_type`, `source`, `timestamp`,
 * `correlation_id`) receive special handling at runtime:
 * - `event_id`, `event_type`, `source`, `timestamp`: STRIPPED from the inner
 *   payload before spreading; a `console.warn` is emitted if any are present.
 *   They will NOT appear in the emitted envelope payload.
 * - `correlation_id` (and `correlationId`): extracted and promoted to the outer
 *   envelope; neither leaks into the inner payload.
 *
 * All other keys are spread directly into the inner payload object. Any key
 * matching a pre-constructed field (`source_path`, `content`, `language`,
 * `operation_type`, `options`, `project_id`, `user_id`) will overwrite the
 * default value. In non-production environments a `console.warn` is emitted
 * when this occurs so unintentional overrides are surfaced during development.
 */
type PayloadOverride = Record<string, unknown>;

/**
 * Error class for intelligence request failures with optional error code.
 * Used when intelligence requests fail with structured error information.
 */
export class IntelligenceError extends Error {
  /** Optional error code from the intelligence service */
  readonly error_code?: string;

  constructor(message: string, error_code?: string) {
    super(message);
    this.name = 'IntelligenceError';
    this.error_code = error_code;
  }
}

/**
 * IntelligenceEventAdapter
 * - Request/response over Kafka for intelligence operations
 * - Correlation ID tracking with in-memory pending map
 * - Timeout + graceful fallback supported by caller
 */
export class IntelligenceEventAdapter {
  private kafka: Kafka;
  private producer: Producer | null = null;
  private consumer: Consumer | null = null;
  private _started = false;

  /** Whether the adapter has been started and is ready for requests */
  get started(): boolean {
    return this._started;
  }

  private pending: Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: any) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();

  // Default topics use canonical ONEX names (see shared/topics.ts).
  // Override via env vars if needed.
  public readonly TOPIC_REQUEST =
    process.env.INTEL_REQUEST_TOPIC || SUFFIX_INTELLIGENCE_CODE_ANALYSIS_CMD;
  public readonly TOPIC_COMPLETED =
    process.env.INTEL_COMPLETED_TOPIC || SUFFIX_INTELLIGENCE_CODE_ANALYSIS_COMPLETED;
  public readonly TOPIC_FAILED =
    process.env.INTEL_FAILED_TOPIC || SUFFIX_INTELLIGENCE_CODE_ANALYSIS_FAILED;

  constructor(
    private readonly brokers: string[] = (() => {
      const brokerString = process.env.KAFKA_BOOTSTRAP_SERVERS || process.env.KAFKA_BROKERS;
      if (!brokerString) {
        throw new Error(
          'KAFKA_BROKERS or KAFKA_BOOTSTRAP_SERVERS environment variable is required. ' +
            'Set it in .env file or export it before starting the server. ' +
            'Example: KAFKA_BROKERS=host:port'
        );
      }
      return brokerString.split(',');
    })()
  ) {
    this.kafka = new Kafka({
      brokers: this.brokers,
      clientId: 'omnidash-intelligence-adapter',
      connectionTimeout: 10000,
      requestTimeout: 30000,
      retry: {
        initialRetryTime: 1000,
        maxRetryTime: 30000,
        retries: 10,
      },
    });
  }

  async start(): Promise<void> {
    if (this._started) return;

    this.producer = this.kafka.producer();
    await this.producer.connect();

    this.consumer = this.kafka.consumer({ groupId: `omnidash-intel-${randomUUID().slice(0, 8)}` });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.TOPIC_COMPLETED, fromBeginning: false });
    await this.consumer.subscribe({ topic: this.TOPIC_FAILED, fromBeginning: false });

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        try {
          const value = message.value?.toString();
          if (!value) return;

          let event: any;
          try {
            event = JSON.parse(value);
          } catch (e) {
            console.warn(
              `[IntelligenceAdapter] Error parsing message from ${topic}:${partition}:${message.offset} - skipping`,
              e
            );
            return;
          }

          // Extract correlation_id (may be top-level or in payload)
          const correlationIdRaw =
            event?.correlation_id ||
            event?.correlationId ||
            event?.payload?.correlation_id ||
            message.key?.toString();
          const correlationId = correlationIdRaw
            ? String(correlationIdRaw).toLowerCase()
            : undefined;
          if (!correlationId) return;

          const pending = this.pending.get(correlationId);
          if (!pending) {
            // A response arrived for a correlationId that is no longer in the
            // pending map. Two causes are possible:
            //   1. The request already timed out — the setTimeout callback fired,
            //      removed the entry, and rejected the caller's promise.
            //   2. producer.send() threw and the catch block cleaned up the entry
            //      before this consumer message was processed (send-failure race).
            // Logging here makes it possible in production to distinguish these
            // two cases from each other and from genuine duplicate deliveries.
            console.warn(
              `[IntelligenceAdapter] Response arrived for unknown or already-cleaned-up correlationId "${correlationId}" ` +
                `(topic=${topic}) — entry may have been removed by a timeout or a send-failure cleanup. Response is dropped.`
            );
            return;
          }
          clearTimeout(pending.timeout);
          this.pending.delete(correlationId);

          if (topic === this.TOPIC_COMPLETED || event?.event_type === 'CODE_ANALYSIS_COMPLETED') {
            // Extract payload from ONEX envelope format
            const result = event?.payload || event;
            pending.resolve(result);
          } else if (topic === this.TOPIC_FAILED || event?.event_type === 'CODE_ANALYSIS_FAILED') {
            // Extract error details from payload
            const errorPayload = event?.payload || event;
            const errorMsg =
              errorPayload?.error_message || errorPayload?.error || 'Intelligence request failed';
            const error = new IntelligenceError(errorMsg, errorPayload?.error_code);
            pending.reject(error);
          }
        } catch (err) {
          // Swallow to avoid consumer crash; the caller gets timeout fallback
          console.error('[IntelligenceAdapter] Error processing response:', err);
        }
      },
    });

    this._started = true;
  }

  async stop(): Promise<void> {
    // Drain all in-flight requests before disconnecting. Without this, the
    // setTimeout callbacks would fire after the producer/consumer are already
    // disconnected, calling reject() on dangling promises and keeping NodeJS
    // timers alive — which can prevent a clean process exit.
    for (const [correlationKey, entry] of this.pending) {
      clearTimeout(entry.timeout);
      entry.reject(
        new Error(
          `IntelligenceEventAdapter stopped before response arrived (correlationId="${correlationKey}")`
        )
      );
    }
    this.pending.clear();

    if (this.consumer) {
      await this.consumer.disconnect();
      this.consumer = null;
    }
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }
    this._started = false;
  }

  /**
   * Generic request method - matches OmniClaude/OmniArchon ONEX event format.
   *
   * See the `PayloadOverride` type for full documentation of how reserved
   * envelope keys and pre-constructed inner payload fields are handled at
   * runtime. In summary:
   * - `event_id`, `event_type`, `source`, `timestamp`: stripped from the
   *   inner payload (with a `console.warn`); do not appear in the output.
   * - `correlation_id` / `correlationId`: extracted and promoted to the outer
   *   envelope; neither leaks into the inner payload.
   * - All other keys are spread into the inner payload. Fields matching
   *   `source_path`, `content`, `language`, `operation_type`, `project_id`,
   *   or `user_id` will overwrite the default value; a `console.warn` is
   *   emitted in non-production environments when this happens.
   *
   * @param requestType - Diagnostic/logging identifier for the request (e.g. `'code_analysis'`).
   *   **This value does NOT map to `event_type` in the Kafka envelope.** The envelope
   *   `event_type` is always hardcoded to `'CODE_ANALYSIS_REQUESTED'` because the adapter
   *   implements a single fixed Kafka round-trip protocol
   *   (`CODE_ANALYSIS_REQUESTED` → `CODE_ANALYSIS_COMPLETED` / `CODE_ANALYSIS_FAILED`).
   *   `requestType` appears only in timeout error messages and is reserved for future
   *   extensibility. If multiple distinct event types are ever needed, a new `topic`
   *   parameter or an overloaded method would be the appropriate extension point — not
   *   repurposing `requestType` to alter `event_type`.
   * @param payload - Additional fields merged into the envelope payload.
   *   See `PayloadOverride` type for key handling details.
   * @param timeoutMs - Milliseconds before the request is rejected with a timeout error (default: 5000).
   */
  async request(
    requestType: string,
    payload: PayloadOverride = {},
    timeoutMs: number = 5000
  ): Promise<any> {
    if (!this._started || !this.producer) throw new Error('IntelligenceEventAdapter not started');

    const rawCid = payload?.correlation_id;
    const rawCidCamel = payload?.correlationId;
    // Prefer correlation_id; fall back to correlationId; only generate a UUID when neither is present.
    // Intentionally avoids || short-circuit so that a falsy-but-valid value like 0 is preserved.
    // NOTE: Callers are responsible for ensuring correlation ID uniqueness. Passing a constant
    // value such as 0 across concurrent requests will result in those requests sharing the same
    // correlation ID string ("0"), which may cause response cross-talk in systems that route
    // responses or aggregate telemetry by correlationId.
    // Number.isFinite() is required for the numeric branch: typeof NaN === 'number' and
    // typeof Infinity === 'number', so without the isFinite guard, NaN/Infinity/-Infinity would
    // be accepted and stringify to 'NaN'/'Infinity'/'-Infinity', causing potential ID collisions.
    const rawCorrelationId =
      typeof rawCid === 'string' || (typeof rawCid === 'number' && Number.isFinite(rawCid))
        ? rawCid
        : typeof rawCidCamel === 'string' ||
            (typeof rawCidCamel === 'number' && Number.isFinite(rawCidCamel))
          ? rawCidCamel
          : randomUUID();
    // rawCorrelationId is always string | number at this point: the typeof guards above ensure
    // only string/number values from the payload are selected, and the UUID fallback is always
    // a string. String() coercion is unconditionally safe.
    const correlationId = String(rawCorrelationId);
    const correlationKey = correlationId.toLowerCase();

    // Guard against duplicate correlation IDs early — before the reservedKeys loop and
    // envelope construction — so we avoid wasteful UUID allocations and object builds for
    // requests that will be rejected anyway.
    if (this.pending.has(correlationKey)) {
      throw new IntelligenceError(
        `Duplicate correlation_id: a request with this ID is already in-flight ("${correlationKey}"). ` +
          'Ensure each concurrent request uses a unique correlation ID.',
        'DUPLICATE_CORRELATION_ID'
      );
    }

    // Exclude correlation_id / correlationId from the inner payload spread so they
    // are not duplicated inside envelope.payload (they belong on the outer envelope only).
    const { correlation_id: _cid, correlationId: _cidCamel, ...payloadRest } = payload;

    const reservedKeys = ['event_id', 'event_type', 'source', 'timestamp'] as const;
    const safePayloadRest: Record<string, unknown> = { ...payloadRest };
    for (const key of reservedKeys) {
      if (key in safePayloadRest) {
        console.warn(
          `[IntelligenceEventAdapter] payload contains reserved envelope key '${key}' — it has been removed to prevent overwriting the outer envelope field. Do not pass envelope-level keys in the payload argument.`
        );
        delete safePayloadRest[key];
      }
    }

    // Dev-only: warn when caller-supplied keys overwrite pre-constructed payload fields (overrides are supported by design).
    // NOTE: This check only fires for non-reserved keys. Reserved keys ('event_id', 'event_type',
    // 'source', 'timestamp') are stripped earlier in the loop above — before this point — so a
    // caller that passes a reserved key (e.g. 'source') which also appears in preConstructedKeys
    // will be silently stripped without triggering this warning. Do NOT add reserved keys to
    // preConstructedKeys expecting them to be caught here; they will never reach this check.
    if (process.env.NODE_ENV !== 'production') {
      const preConstructedKeys = [
        // snake_case canonical names
        'source_path',
        'content',
        'language',
        'operation_type',
        'options', // dev notice: the adapter builds this key automatically from its config; callers may override it intentionally and the override will take effect — this warning is informational only, not a safety guard
        'project_id',
        'user_id',
        // camelCase aliases accepted by the envelope build — warn on these too so
        // callers are not silently overwriting defaults regardless of which casing they use
        'sourcePath',
        'operationType',
        'projectId',
        'userId',
      ] as const;
      for (const key of preConstructedKeys) {
        if (key in safePayloadRest) {
          console.warn(
            `[IntelligenceEventAdapter] payload key '${key}' will overwrite the pre-constructed default value. Pass this key intentionally only if you mean to override the default.`
          );
        }
      }
    }

    // Strip ALL known fields — both camelCase aliases AND snake_case canonicals — from the
    // spread object so that `...safePayloadSpread` (used last in the envelope payload below)
    // only contains truly "extra" fields that this adapter has no knowledge of.
    //
    // WHY this matters: the explicit construction lines below use `||` fallbacks, e.g.
    //   `language: safePayloadRest.language || 'python'`
    // If `language` (or any other known snake_case field) is left in `safePayloadSpread`,
    // the trailing `...safePayloadSpread` spread OVERWRITES the already-constructed default,
    // bypassing the fallback entirely. For example, a caller passing `language: ''` would
    // cause `safePayloadRest.language || 'python'` to correctly evaluate to `'python'`,
    // but then `...safePayloadSpread` would overwrite it back to `''`.
    //
    // Naming distinction:
    //   safePayloadRest   — retains BOTH snake_case canonicals AND camelCase aliases. Used
    //                       ONLY at the explicit construction lines below for default-value
    //                       lookups (e.g. `safePayloadRest.sourcePath || safePayloadRest.source_path`).
    //                       Do NOT spread this variable.
    //   safePayloadSpread — all known fields (both casings) have been removed. Used ONLY
    //                       for the final `...safePayloadSpread` spread into the envelope
    //                       payload. Contains only fields the adapter has no knowledge of.
    //
    // Note: `correlation_id` is already absent here — it was stripped at the earlier
    // `{ correlation_id: _cid, correlationId: _cidCamel, ...payloadRest }` destructure.
    const {
      // camelCase aliases
      sourcePath: _sourcePath,
      operationType: _operationType,
      projectId: _projectId,
      userId: _userId,
      // snake_case canonicals — strip these too so they cannot overwrite the || fallbacks below
      source_path: _source_path,
      content: _content,
      language: _language,
      operation_type: _operation_type,
      project_id: _project_id,
      user_id: _user_id,
      // Strip `options` so the explicit `options: safePayloadRest.options || {}`
      // default below is the single source of this key in the envelope payload.
      // Without this, spreading safePayloadSpread would overwrite the default
      // with the caller value, making the `|| {}` fallback dead code when
      // options is present.
      options: _options,
      ...safePayloadSpread
    } = safePayloadRest;

    // Format matches OmniClaude's _create_request_payload format
    // Handler expects: event_type, correlation_id, payload (with source_path, language, etc.)
    const envelope = {
      event_id: randomUUID(),
      // event_type is intentionally hardcoded — NOT derived from `requestType`.
      // This adapter implements a single fixed Kafka round-trip protocol:
      //   CODE_ANALYSIS_REQUESTED  →  CODE_ANALYSIS_COMPLETED | CODE_ANALYSIS_FAILED
      // The consumer side expects exactly these event types; varying event_type per
      // requestType would break response correlation. `requestType` is used only for
      // diagnostics (timeout error messages) and future extensibility. If multiple
      // event types are ever required, introduce a dedicated `topic` parameter or a
      // new overloaded method rather than repurposing `requestType` for this purpose.
      event_type: 'CODE_ANALYSIS_REQUESTED',
      correlation_id: correlationId,
      timestamp: new Date().toISOString(),
      service: 'omnidash',
      payload: {
        // Coercion strategy: `content` uses `!= null` because empty string is a valid value
        // (e.g. a file with no extractable content). All other structured fields use `||`
        // because empty string is not meaningful for them and should fall back to the default.
        source_path: safePayloadRest.sourcePath || safePayloadRest.source_path || '',
        content: safePayloadRest.content != null ? safePayloadRest.content : null,
        language: safePayloadRest.language || 'python',
        operation_type:
          safePayloadRest.operation_type || safePayloadRest.operationType || 'PATTERN_EXTRACTION',
        options: safePayloadRest.options || {},
        project_id: safePayloadRest.projectId || safePayloadRest.project_id || 'omnidash',
        user_id: safePayloadRest.userId || safePayloadRest.user_id || 'system',
        ...safePayloadSpread, // Allow override of any fields; all known keys (camelCase aliases + snake_case canonicals) already stripped above
      },
    };

    // Promise with timeout tracking
    const promise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(correlationKey);
        reject(
          new Error(
            `Intelligence request timed out after ${timeoutMs}ms (correlationId=${correlationId}, requestType=${requestType})`
          )
        );
      }, timeoutMs);
      this.pending.set(correlationKey, { resolve, reject, timeout });
    });

    try {
      await this.producer.send({
        topic: this.TOPIC_REQUEST,
        messages: [{ key: correlationKey, value: JSON.stringify(envelope) }],
      });
    } catch (sendError) {
      const entry = this.pending.get(correlationKey);
      if (entry) {
        // No race is possible here: JavaScript's event loop is single-threaded, so the
        // setTimeout callback cannot interleave with this synchronous catch block.
        // The `pending.delete` and `entry.reject` execute atomically within this sync
        // block — the timeout handler cannot fire between these two lines.
        clearTimeout(entry.timeout);
        this.pending.delete(correlationKey);
        entry.reject(sendError instanceof Error ? sendError : new Error(String(sendError)));
      } else {
        // entry === null: the timeout handler already fired before producer.send() threw.
        //
        // What happened:
        //   1. The setTimeout callback ran first, deleted the entry from this.pending,
        //      and called reject() on the promise — so `promise` is already settled as
        //      rejected with the "Intelligence request timed out" error.
        //   2. producer.send() then threw (network error, broker unavailable, etc.).
        //   3. We land here with entry === null because step 1 already removed it.
        //
        // The caller's `await request(...)` already received (or will receive) the
        // timeout rejection from step 1 — that is the error the caller should see,
        // because it is the first thing that went wrong from their perspective.
        //
        // The send error is logged separately here so the race is diagnosable in
        // production logs, but it is NOT surfaced to the caller as a second rejection.
        // Allowing a second rejection would create an unhandled Promise rejection
        // and would replace the structured timeout error with a raw Kafka send error.
        //
        // Execution falls through to the single `return promise` at the bottom of the
        // function, so the caller sees exactly one rejection — the timeout — and there
        // is no unhandled rejection surface.
        console.warn(
          `[IntelligenceEventAdapter] send error after timeout for correlationId "${correlationKey}" — ` +
            'the caller already received a timeout rejection; this send error is logged for diagnostics only.',
          sendError
        );
      }
      // Rejection propagates to the caller's await — returning a rejected promise is
      // equivalent to throwing; not a silent swallow.
      //
      // Fall through to the single `return promise` below. entry.reject() above settled
      // `promise` as rejected, so the caller's `await request(...)` receives that rejection
      // as a normally propagated rejected Promise — identical in effect to re-throwing, but
      // without creating a second, unrelated rejection surface or unwrapping the structured
      // IntelligenceError type.
    }

    return promise;
  }

  /**
   * Request pattern discovery (higher-level wrapper)
   */
  async requestPatternDiscovery(
    params: { sourcePath: string; language?: string; project?: string; operationType?: string },
    timeoutMs?: number
  ) {
    return this.request(
      'code_analysis',
      {
        sourcePath: params.sourcePath,
        language: params.language,
        project_id: params.project,
        operation_type: params.operationType || 'PATTERN_EXTRACTION',
      },
      timeoutMs
    );
  }
}

// ============================================================================
// Lazy Initialization Pattern (prevents startup crashes)
// ============================================================================

let intelligenceEventsInstance: IntelligenceEventAdapter | null = null;
let intelligenceInitError: Error | null = null;

/**
 * Get IntelligenceEventAdapter singleton with lazy initialization
 *
 * This pattern prevents the application from crashing at module load time
 * when KAFKA_BROKERS is absent. Note: a missing KAFKA_BROKERS is a
 * misconfiguration error — Kafka is required infrastructure. A null return
 * from this function means the application is not connected to Kafka and
 * is in a degraded/error state.
 *
 * @performance Avoid calling in per-request hot paths. On the **first call**,
 * lazy initialization runs the `IntelligenceEventAdapter` constructor, which
 * reads environment variables and allocates a KafkaJS client object —
 * synchronous work, but non-trivial on the first invocation. No network I/O
 * occurs during construction; broker connections are established only when
 * `start()` is called. On **subsequent calls** (after initialization is
 * cached), the cost is negligible — a null check on a module-level variable.
 * Prefer calling once at startup and caching the result rather than calling
 * on every request.
 *
 * @returns IntelligenceEventAdapter instance or null if initialization failed (error state)
 */
export function getIntelligenceEvents(): IntelligenceEventAdapter | null {
  // Return cached instance if already initialized
  if (intelligenceEventsInstance) {
    return intelligenceEventsInstance;
  }

  // Return null if we previously failed to initialize
  if (intelligenceInitError) {
    return null;
  }

  // Attempt lazy initialization
  try {
    intelligenceEventsInstance = new IntelligenceEventAdapter();
    return intelligenceEventsInstance;
  } catch (error) {
    intelligenceInitError = error instanceof Error ? error : new Error(String(error));
    console.error(
      '❌ IntelligenceEventAdapter initialization failed:',
      intelligenceInitError.message
    );
    console.error(
      '   Kafka is required infrastructure. Set KAFKA_BROKERS in .env to connect to the Redpanda/Kafka broker.'
    );
    console.error(
      '   Intelligence event operations are unavailable — this is an error state, not normal operation.'
    );
    return null;
  }
}

/**
 * Check if IntelligenceEventAdapter is available.
 *
 * Triggers lazy initialization if not yet done, then returns true if the
 * singleton was successfully initialized and false if initialization failed
 * (e.g. KAFKA_BROKERS not configured). Safe to call at any time — no prior
 * call to `getIntelligenceEvents()` is required.
 *
 * @remarks
 * **Side effect**: Triggers lazy initialization of the singleton if not yet
 * initialized. Calling this function is equivalent to calling
 * `getIntelligenceEvents()` plus a null check — both are safe to call at any
 * point.
 *
 * **Behavioral change from pre-lazy-init code**: Previously, `isIntelligenceEventsAvailable()`
 * returned `true` optimistically before any initialization attempt. The current implementation
 * triggers lazy initialization as a side effect on the first call. It returns `true` only after
 * successful initialization completes, and `false` if initialization failed (e.g. KAFKA_BROKERS
 * missing or the IntelligenceEventAdapter constructor threw). Callers that previously relied on
 * the optimistic `true` return before initialization must treat `false` as "Kafka unavailable".
 *
 * @performance Avoid calling in per-request hot paths. On the **first call**,
 * lazy initialization runs the `IntelligenceEventAdapter` constructor, which
 * reads environment variables and allocates a KafkaJS client object —
 * synchronous work, but non-trivial on the first invocation. No network I/O
 * occurs during construction; broker connections are established only when
 * `start()` is called. On **subsequent calls** (after initialization is
 * cached), the cost is negligible — a null check on a module-level variable.
 * Still, the semantic intent of this function is an initialization probe, not
 * a cheap boolean predicate; prefer calling it once at startup and caching
 * the result rather than checking it on every request.
 *
 * @returns `true` if initialization succeeded; `false` if Kafka is not configured or
 *   initialization failed. **Note**: triggers lazy initialization on first call.
 */
export function isIntelligenceEventsAvailable(): boolean {
  // Trigger lazy initialization if not yet done
  getIntelligenceEvents();
  return intelligenceEventsInstance !== null;
}

/**
 * Get initialization error if IntelligenceEventAdapter failed to initialize
 */
export function getIntelligenceEventsError(): Error | null {
  return intelligenceInitError;
}

/**
 * Proxy that delegates all property access to the lazily-initialized IntelligenceEventAdapter.
 * Returns stub implementations that log errors when Kafka is not configured.
 */
export const intelligenceEvents = new Proxy({} as IntelligenceEventAdapter, {
  get(target, prop) {
    const instance = getIntelligenceEvents();
    if (!instance) {
      // Return dummy implementations
      if (prop === 'start') {
        /**
         * Proxy stub for start() when Kafka is not initialized.
         *
         * Throws asynchronously (consistent with the eventConsumer proxy's start stub)
         * so callers awaiting start() receive a rejected promise rather than a silent
         * undefined return. Kafka is required infrastructure — a missing KAFKA_BROKERS
         * env var is a misconfiguration error, not a graceful-degradation scenario.
         *
         * @throws {Error} Always rejects — Kafka was not configured or failed to
         *   initialize. Set KAFKA_BROKERS in .env and restart the server.
         */
        return async (..._args: unknown[]): Promise<never> => {
          throw new Error(
            '[IntelligenceEventAdapter] start() called but Kafka is not available — ' +
              'KAFKA_BROKERS is not configured. Set KAFKA_BROKERS in .env to restore intelligence event streaming.'
          );
        };
      }
      if (prop === 'stop') {
        // Intentionally silent — stop() during shutdown when Kafka was never configured
        // is a benign no-op and should not emit misleading error-level log entries.
        return async () => {};
      }
      if (prop === 'request' || prop === 'requestPatternDiscovery') {
        return async () => {
          throw new Error(
            'IntelligenceEventAdapter not available - KAFKA_BROKERS is not configured. Kafka is required infrastructure.'
          );
        };
      }
      if (prop === 'started') {
        return false;
      }
      // Return readonly topic properties
      if (prop === 'TOPIC_REQUEST' || prop === 'TOPIC_COMPLETED' || prop === 'TOPIC_FAILED') {
        return '';
      }
      // For event emitter registration methods, return no-op stubs consistent with other proxies
      if (prop === 'on' || prop === 'once') {
        return (...args: unknown[]) => {
          // Registering a listener before start() is a normal and expected pattern during init.
          // The listener was NOT registered — Kafka is unavailable so no events will fire.
          console.warn(
            `[IntelligenceEventAdapter] .${prop}() called on stub proxy (event: "${String(args[0])}") — ` +
              'Kafka is not initialized; listener was NOT registered. ' +
              'Set KAFKA_BROKERS in .env to enable real event delivery.'
          );
          return intelligenceEvents; // Return proxy for chaining
        };
      }
      if (prop === 'removeListener') {
        return (...args: unknown[]) => {
          // No-op: there is nothing to remove because on/once stubs never registered a real
          // listener. Teardown cleanup (e.g. component unmount) calling removeListener is a
          // normal pattern — log at warn to avoid polluting teardown logs with spurious errors.
          console.warn(
            `[IntelligenceEventAdapter] .removeListener() called on stub proxy (event: "${String(args[0])}") — ` +
              'no-op because Kafka is not initialized and no listener was ever registered.'
          );
          return intelligenceEvents; // Return proxy for chaining
        };
      }
      if (prop === 'emit') {
        return (...args: unknown[]) => {
          console.error(
            `[IntelligenceEventAdapter] .emit() called on stub proxy (event: "${String(args[0])}") — ` +
              'no-op because Kafka is not initialized; event was not dispatched.'
          );
          // EventEmitter.emit() returns boolean (true if listeners were called).
          // Return false — no listeners exist because Kafka is not initialized.
          return false;
        };
      }
      return undefined;
    }
    // Delegate to actual instance
    // Type assertion needed for Proxy property access - TypeScript doesn't fully support dynamic property access in Proxies
    const value = instance[prop as keyof IntelligenceEventAdapter];
    // Bind methods to preserve 'this' context
    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(instance);
    }
    return value;
  },
});
