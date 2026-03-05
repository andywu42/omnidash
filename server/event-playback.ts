/**
 * Event Playback Service
 *
 * Replays recorded events from JSONL files for demos.
 * Integrates with the existing EventConsumer by emitting to its EventEmitter.
 *
 * Usage:
 *   - Call startPlayback() with a recording file path
 *   - Events are replayed with original timing (or accelerated)
 *   - Dashboard components receive events as if they came from Kafka
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
  SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED,
  SUFFIX_OMNICLAUDE_SESSION_STARTED,
  SUFFIX_OMNICLAUDE_SESSION_ENDED,
  SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
  SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED,
} from '@shared/topics';
import { EventEmitter } from 'events';
import { PLAYBACK_CONFIG, isValidSpeed } from '@shared/schemas/playback-config';

// Get the directory of this module (works in both dev and production)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Recordings directory - resolve relative to module location, not cwd
// In dev: server/event-playback.ts -> ../demo/recordings
// In prod: dist/index.js -> ../demo/recordings
const RECORDINGS_DIR = path.resolve(__dirname, '..', 'demo', 'recordings');

// Test environment detection
const IS_TEST_ENV = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

/**
 * Validate that a file path is within the recordings directory.
 * Prevents path traversal attacks (e.g., ../../../etc/passwd).
 *
 * In test environments, validation is skipped to allow mocked filesystem paths.
 *
 * @param filePath - The file path to validate
 * @returns The resolved absolute path if valid
 * @throws Error if path is outside recordings directory (in production)
 */
function validateRecordingPath(filePath: string): string {
  const resolvedPath = path.resolve(filePath);

  // Skip validation in test environment (allows mocked fs paths)
  if (IS_TEST_ENV) {
    return resolvedPath;
  }

  // Ensure the resolved path is within the recordings directory
  // Use path.sep to ensure we're checking directory boundaries, not partial matches
  if (!resolvedPath.startsWith(RECORDINGS_DIR + path.sep) && resolvedPath !== RECORDINGS_DIR) {
    throw new Error(
      `Invalid recording path: must be within ${path.basename(RECORDINGS_DIR)} directory`
    );
  }

  return resolvedPath;
}

/**
 * Convert an absolute recording path to a relative filename for client display.
 * Prevents exposing server filesystem structure to clients.
 *
 * @param absolutePath - The absolute file path
 * @returns Just the filename, or empty string if no file loaded
 */
function toRelativeRecordingPath(absolutePath: string): string {
  if (!absolutePath) return '';
  return path.basename(absolutePath);
}

// Logger for playback module - matches EventConsumer pattern
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const currentLogLevel = LOG_LEVELS[LOG_LEVEL as keyof typeof LOG_LEVELS] ?? LOG_LEVELS.info;

export const playbackLogger = {
  debug: (message: string) => {
    if (currentLogLevel <= LOG_LEVELS.debug) {
      console.log(`[Playback:debug] ${message}`);
    }
  },
  info: (message: string) => {
    if (currentLogLevel <= LOG_LEVELS.info) {
      console.log(`[Playback] ${message}`);
    }
  },
  warn: (message: string) => {
    if (currentLogLevel <= LOG_LEVELS.warn) {
      console.warn(`[Playback:warn] ${message}`);
    }
  },
  error: (message: string, error?: unknown) => {
    // Errors always log regardless of level
    console.error(`[Playback:error] ${message}`, error ?? '');
  },
};

export interface RecordedEvent {
  timestamp: string;
  relativeMs: number;
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: unknown;
}

export interface PlaybackOptions {
  /** Speed multiplier (1 = real-time, 2 = 2x speed, 0 = instant) */
  speed?: number;
  /** Loop playback continuously */
  loop?: boolean;
  /** Filter to specific topics */
  topics?: string[];
  /** Callback when playback completes */
  onComplete?: () => void;
  /** Callback for each event */
  onEvent?: (event: RecordedEvent) => void;
}

export class EventPlaybackService extends EventEmitter {
  private isPlaying = false;
  private isPaused = false;
  private currentTimeout: NodeJS.Timeout | null = null;
  private currentImmediate: NodeJS.Immediate | null = null;
  private events: RecordedEvent[] = [];
  private currentIndex = 0;
  private options: PlaybackOptions = {};
  private recordingFile: string = '';

  constructor() {
    super();
  }

  /**
   * Load a recording file
   * @param filePath - Path to the recording file (must be within recordings directory)
   * @throws Error if path traversal is attempted or file not found
   */
  loadRecording(filePath: string): RecordedEvent[] {
    // Validate path is within recordings directory (prevents path traversal)
    const absolutePath = validateRecordingPath(filePath);

    if (!fs.existsSync(absolutePath)) {
      // Use relative path in error message to avoid exposing filesystem structure
      throw new Error(`Recording file not found: ${path.basename(filePath)}`);
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    this.events = lines
      .map((line, index) => {
        try {
          return JSON.parse(line) as RecordedEvent;
        } catch (e) {
          playbackLogger.warn(`Failed to parse line ${index + 1}: ${e}`);
          return null;
        }
      })
      .filter((e): e is RecordedEvent => e !== null);

    this.recordingFile = absolutePath;
    playbackLogger.info(`Loaded ${this.events.length} events from ${path.basename(filePath)}`);

    return this.events;
  }

  /**
   * List available recordings in the demo/recordings directory
   * Note: Only returns filename (name) - clients should use name to reference recordings
   * to avoid exposing server filesystem paths
   */
  listRecordings(): { name: string; size: number; eventCount?: number }[] {
    if (!fs.existsSync(RECORDINGS_DIR)) {
      return [];
    }

    return fs
      .readdirSync(RECORDINGS_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const fullPath = path.join(RECORDINGS_DIR, f);
        const stats = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const eventCount = content.trim().split('\n').filter(Boolean).length;

        return {
          name: f,
          // path intentionally omitted to avoid exposing server filesystem paths
          size: stats.size,
          eventCount,
        };
      })
      .sort((a, b) => b.size - a.size);
  }

  /**
   * Start playback
   */
  async startPlayback(filePath: string, options: PlaybackOptions = {}): Promise<void> {
    if (this.isPlaying) {
      playbackLogger.info('Already playing, stopping current playback...');
      this.stopPlayback();
    }

    this.loadRecording(filePath);
    this.options = {
      speed: 1,
      loop: false,
      ...options,
    };
    this.currentIndex = 0;
    this.isPlaying = true;
    this.isPaused = false;

    playbackLogger.info(`Starting playback at ${this.options.speed}x speed`);
    // Use relative path in emitted event to avoid exposing server filesystem
    this.emit('playbackStart', {
      file: toRelativeRecordingPath(this.recordingFile),
      eventCount: this.events.length,
    });

    await this.playNextEvent();
  }

  /**
   * Play the next event in sequence
   */
  private async playNextEvent(): Promise<void> {
    if (!this.isPlaying || this.isPaused) return;

    if (this.currentIndex >= this.events.length) {
      if (this.options.loop) {
        playbackLogger.info('Looping...');
        this.currentIndex = 0;
        this.emit('playbackLoop');
      } else {
        this.stopPlayback();
        this.options.onComplete?.();
        return;
      }
    }

    const event = this.events[this.currentIndex];
    const nextEvent = this.events[this.currentIndex + 1];

    // Filter by topics if specified
    if (this.options.topics && !this.options.topics.includes(event.topic)) {
      this.currentIndex++;
      this.currentImmediate = setImmediate(() => this.playNextEvent());
      return;
    }

    // Emit the event
    this.emitEvent(event);
    this.options.onEvent?.(event);

    this.currentIndex++;

    // Schedule next event
    const configuredSpeed = this.options.speed ?? PLAYBACK_CONFIG.DEFAULT_SPEED;
    if (nextEvent && configuredSpeed !== 0) {
      // Defensive validation: ensure speed is finite and positive to avoid NaN/Infinity delays
      const speed =
        Number.isFinite(configuredSpeed) && configuredSpeed > 0
          ? configuredSpeed
          : PLAYBACK_CONFIG.DEFAULT_SPEED; // Default to 1x if invalid
      const delay = (nextEvent.relativeMs - event.relativeMs) / speed;
      // Ensure delay is finite and non-negative
      const safeDelay = Number.isFinite(delay) ? Math.max(0, delay) : 0;
      this.currentTimeout = setTimeout(() => this.playNextEvent(), safeDelay);
    } else {
      // Instant mode or last event
      // Yield to event loop every 50 events to prevent CPU blocking
      if (configuredSpeed === 0 && this.currentIndex % 50 === 0) {
        this.currentTimeout = setTimeout(() => this.playNextEvent(), 0);
      } else {
        this.currentImmediate = setImmediate(() => this.playNextEvent());
      }
    }
  }

  /**
   * Emit an event to the appropriate handler based on topic
   */
  private emitEvent(event: RecordedEvent): void {
    // Emit generic event
    this.emit('event', event);

    // Emit topic-specific events that match EventConsumer patterns
    const value = event.value as Record<string, unknown>;

    // Match topic names — supports both canonical resolved names and
    // legacy names from older recordings.
    const topic = event.topic;
    switch (topic) {
      case TOPIC_OMNICLAUDE_ROUTING_DECISIONS:
        this.emit('routingDecision', value);
        break;
      case TOPIC_OMNICLAUDE_AGENT_ACTIONS:
        this.emit('action', value);
        break;
      case TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION:
        this.emit('transformation', value);
        break;
      case TOPIC_OMNICLAUDE_PERFORMANCE_METRICS:
        this.emit('performanceMetric', value);
        break;
      default:
        // ONEX topics: match by suffix (handles any env prefix in recordings)
        if (topic.endsWith(SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED)) {
          this.emit('promptSubmitted', value);
        } else if (topic.endsWith(SUFFIX_OMNICLAUDE_SESSION_STARTED)) {
          this.emit('sessionStarted', value);
        } else if (topic.endsWith(SUFFIX_OMNICLAUDE_SESSION_ENDED)) {
          this.emit('sessionEnded', value);
        } else if (topic.endsWith(SUFFIX_OMNICLAUDE_TOOL_EXECUTED)) {
          this.emit('toolExecuted', value);
        } else if (topic.endsWith(SUFFIX_INTELLIGENCE_INTENT_CLASSIFIED)) {
          this.emit('intentClassified', value);
        } else {
          this.emit('unknownTopic', event);
        }
    }
  }

  /**
   * Pause playback
   */
  pausePlayback(): void {
    if (!this.isPlaying) return;

    this.isPaused = true;
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
    if (this.currentImmediate) {
      clearImmediate(this.currentImmediate);
      this.currentImmediate = null;
    }

    playbackLogger.info(`Paused at event ${this.currentIndex}/${this.events.length}`);
    this.emit('playbackPause');
  }

  /**
   * Resume playback
   */
  resumePlayback(): void {
    if (!this.isPlaying || !this.isPaused) return;

    this.isPaused = false;
    playbackLogger.info('Resumed');
    this.emit('playbackResume');
    this.playNextEvent();
  }

  /**
   * Stop playback
   */
  stopPlayback(): void {
    this.isPlaying = false;
    this.isPaused = false;

    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
    if (this.currentImmediate) {
      clearImmediate(this.currentImmediate);
      this.currentImmediate = null;
    }

    playbackLogger.info('Stopped');
    this.emit('playbackStop');
  }

  /**
   * Get playback status
   * Note: recordingFile returns only the filename to avoid exposing server filesystem paths
   */
  getStatus(): {
    isPlaying: boolean;
    isPaused: boolean;
    currentIndex: number;
    totalEvents: number;
    progress: number;
    recordingFile: string;
  } {
    return {
      isPlaying: this.isPlaying,
      isPaused: this.isPaused,
      currentIndex: this.currentIndex,
      totalEvents: this.events.length,
      progress: this.events.length > 0 ? (this.currentIndex / this.events.length) * 100 : 0,
      // Return only filename to avoid exposing server filesystem paths to clients
      recordingFile: toRelativeRecordingPath(this.recordingFile),
    };
  }

  /**
   * Set playback speed
   * If currently playing, reschedules the next event with the new speed
   *
   * Valid speed values:
   * - 0: Instant mode (process all events immediately)
   * - 0.1-100: Speed multiplier (0.5x, 1x, 2x, etc.)
   */
  setSpeed(speed: number): void {
    // Validate speed using shared validation (prevents NaN, Infinity, out-of-range)
    if (!Number.isFinite(speed) || !isValidSpeed(speed)) {
      playbackLogger.warn(
        `Invalid speed value: ${speed}. Must be ${PLAYBACK_CONFIG.INSTANT_SPEED} (instant) ` +
          `or between ${PLAYBACK_CONFIG.MIN_SPEED} and ${PLAYBACK_CONFIG.MAX_SPEED}. Ignoring.`
      );
      return;
    }
    this.options.speed = speed;
    playbackLogger.info(`Speed set to ${speed}x`);
    this.emit('speedChange', speed);

    // If actively playing (not paused), reschedule with new speed
    if (this.isPlaying && !this.isPaused) {
      if (this.currentTimeout) {
        clearTimeout(this.currentTimeout);
        this.currentTimeout = null;
      }
      if (this.currentImmediate) {
        clearImmediate(this.currentImmediate);
        this.currentImmediate = null;
      }
      // Schedule next event with new speed
      this.playNextEvent();
    }
  }

  /**
   * Set loop mode
   * Can be toggled during playback
   */
  setLoop(loop: boolean): void {
    this.options.loop = loop;
    playbackLogger.info(`Loop ${loop ? 'enabled' : 'disabled'}`);
    this.emit('loopChange', loop);
  }
}

// Singleton instance for server-wide use
let playbackInstance: EventPlaybackService | null = null;

export function getPlaybackService(): EventPlaybackService {
  if (!playbackInstance) {
    playbackInstance = new EventPlaybackService();
  }
  return playbackInstance;
}
