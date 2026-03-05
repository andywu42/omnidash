import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
} from '@shared/topics';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

// Import after mocks are set up
import {
  EventPlaybackService,
  getPlaybackService,
  RecordedEvent,
  type PlaybackOptions as _PlaybackOptions,
} from '../event-playback';

describe('EventPlaybackService', () => {
  let service: EventPlaybackService;

  // Sample recorded events for testing
  const sampleEvents: RecordedEvent[] = [
    {
      timestamp: '2024-01-01T00:00:00.000Z',
      relativeMs: 0,
      topic: TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
      partition: 0,
      offset: '0',
      key: null,
      value: { selectedAgent: 'agent-api', confidence: 0.95 },
    },
    {
      timestamp: '2024-01-01T00:00:00.100Z',
      relativeMs: 100,
      topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
      partition: 0,
      offset: '1',
      key: null,
      value: { agentName: 'agent-api', actionType: 'tool_call' },
    },
    {
      timestamp: '2024-01-01T00:00:00.200Z',
      relativeMs: 200,
      topic: TOPIC_OMNICLAUDE_AGENT_TRANSFORMATION,
      partition: 0,
      offset: '2',
      key: null,
      value: { sourceAgent: 'agent-a', targetAgent: 'agent-b' },
    },
    {
      timestamp: '2024-01-01T00:00:00.300Z',
      relativeMs: 300,
      topic: TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
      partition: 0,
      offset: '3',
      key: null,
      value: { routingDurationMs: 45, cacheHit: true },
    },
    {
      timestamp: '2024-01-01T00:00:00.400Z',
      relativeMs: 400,
      topic: 'dev.onex.evt.omniclaude.prompt-submitted.v1',
      partition: 0,
      offset: '4',
      key: null,
      value: { prompt: 'test prompt', sessionId: 'session-1' },
    },
  ];

  const createJsonlContent = (events: RecordedEvent[]): string => {
    return events.map((e) => JSON.stringify(e)).join('\n');
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    service = new EventPlaybackService();
  });

  afterEach(async () => {
    // Clean up any active playback
    service.stopPlayback();
    service.removeAllListeners();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize as EventEmitter', () => {
      expect(service).toBeInstanceOf(EventEmitter);
    });

    it('should have initial state as not playing', () => {
      const status = service.getStatus();
      expect(status.isPlaying).toBe(false);
      expect(status.isPaused).toBe(false);
      expect(status.currentIndex).toBe(0);
      expect(status.totalEvents).toBe(0);
    });
  });

  describe('loadRecording', () => {
    it('should load events from a valid JSONL file', () => {
      const filePath = '/path/to/recording.jsonl';
      const content = createJsonlContent(sampleEvents);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const events = service.loadRecording(filePath);

      expect(events).toHaveLength(5);
      expect(events[0].topic).toBe(TOPIC_OMNICLAUDE_ROUTING_DECISIONS);
      expect(events[1].topic).toBe(TOPIC_OMNICLAUDE_AGENT_ACTIONS);
    });

    it('should throw error for non-existent file', () => {
      const filePath = '/path/to/nonexistent.jsonl';

      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(() => service.loadRecording(filePath)).toThrow('Recording file not found');
    });

    it('should handle empty file', () => {
      const filePath = '/path/to/empty.jsonl';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('');

      const events = service.loadRecording(filePath);

      expect(events).toHaveLength(0);
    });

    it('should skip malformed JSON lines and continue parsing', () => {
      const filePath = '/path/to/mixed.jsonl';
      const validEvent = sampleEvents[0];
      const content = `${JSON.stringify(validEvent)}\n{ invalid json\n${JSON.stringify(sampleEvents[1])}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const events = service.loadRecording(filePath);

      expect(events).toHaveLength(2);
      // The console.warn is called with the message and the error object
      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toContain('Failed to parse line 2');

      consoleSpy.mockRestore();
    });

    it('should handle file with blank lines', () => {
      const filePath = '/path/to/blank-lines.jsonl';
      const content = `${JSON.stringify(sampleEvents[0])}\n\n${JSON.stringify(sampleEvents[1])}\n\n`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const events = service.loadRecording(filePath);

      expect(events).toHaveLength(2);
    });

    it('should resolve relative paths to absolute', () => {
      const relativePath = 'demo/recordings/test.jsonl';
      const content = createJsonlContent([sampleEvents[0]]);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      service.loadRecording(relativePath);

      expect(fs.existsSync).toHaveBeenCalledWith(path.resolve(relativePath));
    });

    it('should update recordingFile in status after loading', () => {
      const filePath = '/path/to/recording.jsonl';
      const content = createJsonlContent(sampleEvents);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      service.loadRecording(filePath);

      const status = service.getStatus();
      // getStatus returns only the filename to avoid exposing filesystem paths
      expect(status.recordingFile).toBe('recording.jsonl');
      expect(status.totalEvents).toBe(5);
    });
  });

  describe('listRecordings', () => {
    it('should return empty array if recordings directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const recordings = service.listRecordings();

      expect(recordings).toEqual([]);
    });

    it('should list all JSONL files in recordings directory', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'recording1.jsonl',
        'recording2.jsonl',
        'readme.txt',
      ] as any);
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('{"event":1}\n{"event":2}');

      const recordings = service.listRecordings();

      expect(recordings).toHaveLength(2);
      expect(recordings[0].name).toBe('recording1.jsonl');
      expect(recordings[1].name).toBe('recording2.jsonl');
    });

    it('should include file size and event count', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['test.jsonl'] as any);
      vi.mocked(fs.statSync).mockReturnValue({ size: 2048 } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('{"a":1}\n{"b":2}\n{"c":3}');

      const recordings = service.listRecordings();

      expect(recordings[0].size).toBe(2048);
      expect(recordings[0].eventCount).toBe(3);
    });

    it('should sort recordings by size descending', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'small.jsonl',
        'large.jsonl',
        'medium.jsonl',
      ] as any);
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ size: 100 } as any) // small
        .mockReturnValueOnce({ size: 1000 } as any) // large
        .mockReturnValueOnce({ size: 500 } as any); // medium
      vi.mocked(fs.readFileSync).mockReturnValue('{}');

      const recordings = service.listRecordings();

      expect(recordings[0].name).toBe('large.jsonl');
      expect(recordings[1].name).toBe('medium.jsonl');
      expect(recordings[2].name).toBe('small.jsonl');
    });

    it('should filter out non-JSONL files', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'valid.jsonl',
        'readme.md',
        'data.json',
        'script.js',
      ] as any);
      vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('{}');

      const recordings = service.listRecordings();

      expect(recordings).toHaveLength(1);
      expect(recordings[0].name).toBe('valid.jsonl');
    });
  });

  describe('startPlayback', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(createJsonlContent(sampleEvents));
    });

    it('should start playback and emit playbackStart event', async () => {
      const startSpy = vi.fn();
      service.on('playbackStart', startSpy);

      void service.startPlayback('/path/to/recording.jsonl');
      await vi.advanceTimersByTimeAsync(0);

      expect(startSpy).toHaveBeenCalledWith({
        file: expect.any(String),
        eventCount: 5,
      });

      const status = service.getStatus();
      expect(status.isPlaying).toBe(true);
      expect(status.isPaused).toBe(false);
    });

    it('should stop existing playback before starting new one', async () => {
      const stopSpy = vi.fn();
      service.on('playbackStop', stopSpy);

      // Start first playback
      service.startPlayback('/path/to/recording.jsonl');
      await vi.advanceTimersByTimeAsync(50);

      expect(service.getStatus().isPlaying).toBe(true);

      // Start second playback (should stop first)
      service.startPlayback('/path/to/recording.jsonl');
      await vi.advanceTimersByTimeAsync(0);

      expect(stopSpy).toHaveBeenCalled();
    });

    it('should use default options when none provided', async () => {
      service.startPlayback('/path/to/recording.jsonl');
      await vi.advanceTimersByTimeAsync(0);

      const status = service.getStatus();
      expect(status.isPlaying).toBe(true);
    });

    it('should respect custom speed option', async () => {
      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      // Start at 2x speed (delays should be halved)
      service.startPlayback('/path/to/recording.jsonl', { speed: 2 });

      // At 2x speed, 100ms delay becomes 50ms
      await vi.advanceTimersByTimeAsync(0); // First event (relativeMs: 0)
      await vi.advanceTimersByTimeAsync(50); // Second event (100ms / 2 = 50ms)

      expect(eventSpy).toHaveBeenCalledTimes(2);
    });

    it('should play all events instantly when speed is 0', async () => {
      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 0 });

      // Use runAllTimersAsync to process all setImmediate/setTimeout calls
      await vi.runAllTimersAsync();

      expect(eventSpy).toHaveBeenCalledTimes(5);
    });

    it('should filter events by topics when specified', async () => {
      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      service.startPlayback('/path/to/recording.jsonl', {
        speed: 0,
        topics: [TOPIC_OMNICLAUDE_AGENT_ACTIONS],
      });

      // Use runAllTimersAsync to process all events
      await vi.runAllTimersAsync();

      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(eventSpy.mock.calls[0][0].topic).toBe(TOPIC_OMNICLAUDE_AGENT_ACTIONS);
    });

    it('should call onEvent callback for each event', async () => {
      const onEventSpy = vi.fn();

      service.startPlayback('/path/to/recording.jsonl', {
        speed: 0,
        onEvent: onEventSpy,
      });

      // Use runAllTimersAsync to process all events
      await vi.runAllTimersAsync();

      expect(onEventSpy).toHaveBeenCalledTimes(5);
    });

    it('should call onComplete callback when playback finishes', async () => {
      const onCompleteSpy = vi.fn();

      service.startPlayback('/path/to/recording.jsonl', {
        speed: 0,
        onComplete: onCompleteSpy,
      });

      // Use runAllTimersAsync to process all events
      await vi.runAllTimersAsync();

      expect(onCompleteSpy).toHaveBeenCalled();
    });

    it('should loop playback when loop option is true', async () => {
      const loopSpy = vi.fn();
      const eventSpy = vi.fn();
      service.on('playbackLoop', loopSpy);
      service.on('event', eventSpy);

      // Use timed playback for loop test to avoid infinite loop with runAllTimersAsync
      service.startPlayback('/path/to/recording.jsonl', {
        speed: 100, // 100x speed - events happen quickly
        loop: true,
      });

      // Advance enough time for first loop (400ms of event time / 100 = 4ms + buffer)
      // Then a bit more to start second loop
      await vi.advanceTimersByTimeAsync(10);

      expect(loopSpy).toHaveBeenCalled();
      expect(eventSpy.mock.calls.length).toBeGreaterThanOrEqual(5); // At least first loop completed
    });
  });

  describe('pausePlayback', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(createJsonlContent(sampleEvents));
    });

    it('should pause playback and emit playbackPause event', async () => {
      const pauseSpy = vi.fn();
      service.on('playbackPause', pauseSpy);

      service.startPlayback('/path/to/recording.jsonl');
      await vi.advanceTimersByTimeAsync(50);

      service.pausePlayback();

      expect(pauseSpy).toHaveBeenCalled();
      expect(service.getStatus().isPaused).toBe(true);
      expect(service.getStatus().isPlaying).toBe(true); // Still "playing" but paused
    });

    it('should stop emitting events when paused', async () => {
      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 1 });
      await vi.advanceTimersByTimeAsync(0); // First event

      const eventCountBeforePause = eventSpy.mock.calls.length;
      service.pausePlayback();

      // Advance time significantly
      await vi.advanceTimersByTimeAsync(1000);

      expect(eventSpy.mock.calls.length).toBe(eventCountBeforePause);
    });

    it('should do nothing if not playing', () => {
      const pauseSpy = vi.fn();
      service.on('playbackPause', pauseSpy);

      service.pausePlayback();

      expect(pauseSpy).not.toHaveBeenCalled();
    });

    it('should preserve current position when paused', async () => {
      service.startPlayback('/path/to/recording.jsonl', { speed: 1 });
      await vi.advanceTimersByTimeAsync(0); // Process first event

      const indexBeforePause = service.getStatus().currentIndex;
      service.pausePlayback();

      await vi.advanceTimersByTimeAsync(1000);

      expect(service.getStatus().currentIndex).toBe(indexBeforePause);
    });
  });

  describe('resumePlayback', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(createJsonlContent(sampleEvents));
    });

    it('should resume playback and emit playbackResume event', async () => {
      const resumeSpy = vi.fn();
      service.on('playbackResume', resumeSpy);

      service.startPlayback('/path/to/recording.jsonl');
      await vi.advanceTimersByTimeAsync(50);
      service.pausePlayback();
      service.resumePlayback();

      expect(resumeSpy).toHaveBeenCalled();
      expect(service.getStatus().isPaused).toBe(false);
    });

    it('should continue emitting events after resume', async () => {
      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
      await vi.advanceTimersByTimeAsync(0); // First event

      service.pausePlayback();
      const countAfterPause = eventSpy.mock.calls.length;

      service.resumePlayback();

      // Use runAllTimersAsync to process remaining events
      await vi.runAllTimersAsync();

      expect(eventSpy.mock.calls.length).toBeGreaterThan(countAfterPause);
    });

    it('should do nothing if not playing', () => {
      const resumeSpy = vi.fn();
      service.on('playbackResume', resumeSpy);

      service.resumePlayback();

      expect(resumeSpy).not.toHaveBeenCalled();
    });

    it('should do nothing if not paused', async () => {
      const resumeSpy = vi.fn();
      service.on('playbackResume', resumeSpy);

      service.startPlayback('/path/to/recording.jsonl');
      await vi.advanceTimersByTimeAsync(0);

      service.resumePlayback();

      expect(resumeSpy).not.toHaveBeenCalled();
    });
  });

  describe('stopPlayback', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(createJsonlContent(sampleEvents));
    });

    it('should stop playback and emit playbackStop event', async () => {
      const stopSpy = vi.fn();
      service.on('playbackStop', stopSpy);

      service.startPlayback('/path/to/recording.jsonl');
      await vi.advanceTimersByTimeAsync(50);

      service.stopPlayback();

      expect(stopSpy).toHaveBeenCalled();
      expect(service.getStatus().isPlaying).toBe(false);
      expect(service.getStatus().isPaused).toBe(false);
    });

    it('should stop emitting events after stop', async () => {
      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 1 });
      await vi.advanceTimersByTimeAsync(0);

      const countBeforeStop = eventSpy.mock.calls.length;
      service.stopPlayback();

      await vi.advanceTimersByTimeAsync(1000);

      expect(eventSpy.mock.calls.length).toBe(countBeforeStop);
    });

    it('should clear pending timeout', async () => {
      service.startPlayback('/path/to/recording.jsonl', { speed: 1 });
      await vi.advanceTimersByTimeAsync(50);

      service.stopPlayback();

      // Verify no more events are emitted even if timer would have fired
      const eventSpy = vi.fn();
      service.on('event', eventSpy);
      await vi.advanceTimersByTimeAsync(500);

      expect(eventSpy).not.toHaveBeenCalled();
    });

    it('should be safe to call when not playing', () => {
      expect(() => service.stopPlayback()).not.toThrow();
    });

    it('should reset paused state', async () => {
      service.startPlayback('/path/to/recording.jsonl');
      await vi.advanceTimersByTimeAsync(50);
      service.pausePlayback();

      expect(service.getStatus().isPaused).toBe(true);

      service.stopPlayback();

      expect(service.getStatus().isPaused).toBe(false);
    });
  });

  describe('getStatus', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(createJsonlContent(sampleEvents));
    });

    it('should return correct initial status', () => {
      const status = service.getStatus();

      expect(status).toEqual({
        isPlaying: false,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 0,
        progress: 0,
        recordingFile: '',
      });
    });

    it('should return correct status during playback', async () => {
      service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      const status = service.getStatus();

      expect(status.isPlaying).toBe(true);
      expect(status.isPaused).toBe(false);
      expect(status.totalEvents).toBe(5);
      expect(status.currentIndex).toBeGreaterThan(0);
      expect(status.progress).toBeGreaterThan(0);
    });

    it('should calculate progress correctly', async () => {
      service.startPlayback('/path/to/recording.jsonl', { speed: 0 });

      // Process 2 out of 5 events (40%)
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      const status = service.getStatus();
      expect(status.progress).toBe(40); // 2/5 * 100
    });

    it('should return 0 progress when no events loaded', () => {
      const status = service.getStatus();
      expect(status.progress).toBe(0);
    });

    it('should show paused state correctly', async () => {
      service.startPlayback('/path/to/recording.jsonl');
      await vi.advanceTimersByTimeAsync(50);
      service.pausePlayback();

      const status = service.getStatus();

      expect(status.isPlaying).toBe(true);
      expect(status.isPaused).toBe(true);
    });
  });

  describe('setSpeed', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(createJsonlContent(sampleEvents));
    });

    it('should update speed and emit speedChange event', async () => {
      const speedSpy = vi.fn();
      service.on('speedChange', speedSpy);

      service.startPlayback('/path/to/recording.jsonl');
      await vi.advanceTimersByTimeAsync(0);

      service.setSpeed(2);

      expect(speedSpy).toHaveBeenCalledWith(2);
    });

    it('should reschedule next event with new speed when playing', async () => {
      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 1 });
      await vi.advanceTimersByTimeAsync(0); // First event

      eventSpy.mockClear();

      // Change to instant speed
      service.setSpeed(0);

      // Use runAllTimersAsync to process remaining events instantly
      await vi.runAllTimersAsync();

      expect(eventSpy.mock.calls.length).toBeGreaterThan(0);
    });

    it('should not reschedule when paused', async () => {
      service.startPlayback('/path/to/recording.jsonl');
      await vi.advanceTimersByTimeAsync(50);
      service.pausePlayback();

      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      service.setSpeed(0);

      await vi.advanceTimersByTimeAsync(100);

      // Should not emit any events because playback is paused
      expect(eventSpy).not.toHaveBeenCalled();
    });

    it('should work when not playing', () => {
      const speedSpy = vi.fn();
      service.on('speedChange', speedSpy);

      service.setSpeed(3);

      expect(speedSpy).toHaveBeenCalledWith(3);
    });
  });

  describe('event emission', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(createJsonlContent(sampleEvents));
    });

    it('should emit routingDecision for agent-routing-decisions topic', async () => {
      const routingSpy = vi.fn();
      service.on('routingDecision', routingSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
      await vi.advanceTimersByTimeAsync(0);

      expect(routingSpy).toHaveBeenCalledWith({ selectedAgent: 'agent-api', confidence: 0.95 });
    });

    it('should emit action for agent-actions topic', async () => {
      const actionSpy = vi.fn();
      service.on('action', actionSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
      await vi.runAllTimersAsync();

      expect(actionSpy).toHaveBeenCalledWith({ agentName: 'agent-api', actionType: 'tool_call' });
    });

    it('should emit transformation for agent-transformation-events topic', async () => {
      const transformSpy = vi.fn();
      service.on('transformation', transformSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
      await vi.runAllTimersAsync();

      expect(transformSpy).toHaveBeenCalledWith({ sourceAgent: 'agent-a', targetAgent: 'agent-b' });
    });

    it('should emit performanceMetric for router-performance-metrics topic', async () => {
      const perfSpy = vi.fn();
      service.on('performanceMetric', perfSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
      await vi.runAllTimersAsync();

      expect(perfSpy).toHaveBeenCalledWith({ routingDurationMs: 45, cacheHit: true });
    });

    it('should emit promptSubmitted for OmniClaude prompt topic', async () => {
      const promptSpy = vi.fn();
      service.on('promptSubmitted', promptSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
      await vi.runAllTimersAsync();

      expect(promptSpy).toHaveBeenCalledWith({ prompt: 'test prompt', sessionId: 'session-1' });
    });

    it('should emit unknownTopic for unrecognized topics', async () => {
      const unknownEvent: RecordedEvent = {
        timestamp: '2024-01-01T00:00:00.000Z',
        relativeMs: 0,
        topic: 'some-unknown-topic',
        partition: 0,
        offset: '0',
        key: null,
        value: { data: 'test' },
      };

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(unknownEvent));

      const unknownSpy = vi.fn();
      service.on('unknownTopic', unknownSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
      await vi.advanceTimersByTimeAsync(0);

      expect(unknownSpy).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'some-unknown-topic' })
      );
    });

    it('should emit generic event for all events', async () => {
      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
      await vi.runAllTimersAsync();

      expect(eventSpy).toHaveBeenCalledTimes(5);
    });

    describe('OmniClaude lifecycle events', () => {
      it('should emit sessionStarted for session-started topic', async () => {
        const sessionEvent: RecordedEvent = {
          timestamp: '2024-01-01T00:00:00.000Z',
          relativeMs: 0,
          topic: 'dev.onex.evt.omniclaude.session-started.v1',
          partition: 0,
          offset: '0',
          key: null,
          value: { sessionId: 'session-1', workingDir: '/test' },
        };

        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(sessionEvent));

        const sessionSpy = vi.fn();
        service.on('sessionStarted', sessionSpy);

        service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionSpy).toHaveBeenCalledWith({ sessionId: 'session-1', workingDir: '/test' });
      });

      it('should emit sessionEnded for session-ended topic', async () => {
        const sessionEvent: RecordedEvent = {
          timestamp: '2024-01-01T00:00:00.000Z',
          relativeMs: 0,
          topic: 'dev.onex.evt.omniclaude.session-ended.v1',
          partition: 0,
          offset: '0',
          key: null,
          value: { sessionId: 'session-1', duration: 3600 },
        };

        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(sessionEvent));

        const sessionSpy = vi.fn();
        service.on('sessionEnded', sessionSpy);

        service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionSpy).toHaveBeenCalledWith({ sessionId: 'session-1', duration: 3600 });
      });

      it('should emit toolExecuted for tool-executed topic', async () => {
        const toolEvent: RecordedEvent = {
          timestamp: '2024-01-01T00:00:00.000Z',
          relativeMs: 0,
          topic: 'dev.onex.evt.omniclaude.tool-executed.v1',
          partition: 0,
          offset: '0',
          key: null,
          value: { toolName: 'Read', success: true },
        };

        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(toolEvent));

        const toolSpy = vi.fn();
        service.on('toolExecuted', toolSpy);

        service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
        await vi.advanceTimersByTimeAsync(0);

        expect(toolSpy).toHaveBeenCalledWith({ toolName: 'Read', success: true });
      });

      it('should emit intentClassified for intent-classified topic', async () => {
        const intentEvent: RecordedEvent = {
          timestamp: '2024-01-01T00:00:00.000Z',
          relativeMs: 0,
          topic: 'dev.onex.evt.omniintelligence.intent-classified.v1',
          partition: 0,
          offset: '0',
          key: null,
          value: { intent: 'code_generation', confidence: 0.92 },
        };

        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(intentEvent));

        const intentSpy = vi.fn();
        service.on('intentClassified', intentSpy);

        service.startPlayback('/path/to/recording.jsonl', { speed: 0 });
        await vi.advanceTimersByTimeAsync(0);

        expect(intentSpy).toHaveBeenCalledWith({ intent: 'code_generation', confidence: 0.92 });
      });
    });
  });

  describe('getPlaybackService singleton', () => {
    it('should return same instance on multiple calls', () => {
      const instance1 = getPlaybackService();
      const instance2 = getPlaybackService();

      expect(instance1).toBe(instance2);
    });

    it('should return an EventPlaybackService instance', () => {
      const instance = getPlaybackService();
      expect(instance).toBeInstanceOf(EventPlaybackService);
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
    });

    it('should handle single event recording', async () => {
      const singleEvent: RecordedEvent[] = [sampleEvents[0]];
      vi.mocked(fs.readFileSync).mockReturnValue(createJsonlContent(singleEvent));

      const completeSpy = vi.fn();
      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      service.startPlayback('/path/to/single.jsonl', {
        speed: 0,
        onComplete: completeSpy,
      });

      await vi.runAllTimersAsync();

      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(completeSpy).toHaveBeenCalled();
    });

    it('should handle empty recording file gracefully', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('');

      const completeSpy = vi.fn();

      service.startPlayback('/path/to/empty.jsonl', {
        speed: 0,
        onComplete: completeSpy,
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(completeSpy).toHaveBeenCalled();
      expect(service.getStatus().isPlaying).toBe(false);
    });

    it('should handle rapid pause/resume cycles', async () => {
      // Use more events to prevent playback from completing during cycles
      const manyEvents: RecordedEvent[] = [];
      for (let i = 0; i < 20; i++) {
        manyEvents.push({
          timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
          relativeMs: i * 100, // 100ms between events
          topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
          partition: 0,
          offset: String(i),
          key: null,
          value: { index: i },
        });
      }
      vi.mocked(fs.readFileSync).mockReturnValue(createJsonlContent(manyEvents));

      service.startPlayback('/path/to/recording.jsonl', { speed: 1 });
      await vi.advanceTimersByTimeAsync(0); // First event

      // Do rapid pause/resume cycles without advancing time much
      for (let i = 0; i < 5; i++) {
        service.pausePlayback();
        service.resumePlayback();
      }

      const status = service.getStatus();
      expect(status.isPlaying).toBe(true);
      expect(status.isPaused).toBe(false);
    });

    it('should handle multiple speed changes during playback', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(createJsonlContent(sampleEvents));

      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      service.startPlayback('/path/to/recording.jsonl', { speed: 1 });
      await vi.advanceTimersByTimeAsync(0);

      service.setSpeed(2);
      await vi.advanceTimersByTimeAsync(25);
      service.setSpeed(0.5);
      await vi.advanceTimersByTimeAsync(100);
      service.setSpeed(0);

      // Use runAllTimersAsync to process remaining events
      await vi.runAllTimersAsync();

      expect(eventSpy.mock.calls.length).toBeGreaterThan(0);
    });

    it('should yield to event loop every 50 events in instant mode', async () => {
      // Create recording with more than 50 events
      const manyEvents: RecordedEvent[] = [];
      for (let i = 0; i < 100; i++) {
        manyEvents.push({
          timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
          relativeMs: i,
          topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
          partition: 0,
          offset: String(i),
          key: null,
          value: { index: i },
        });
      }

      vi.mocked(fs.readFileSync).mockReturnValue(createJsonlContent(manyEvents));

      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      service.startPlayback('/path/to/large.jsonl', { speed: 0 });

      // Use runAllTimersAsync to process all events including the setTimeout yields
      await vi.runAllTimersAsync();

      expect(eventSpy.mock.calls.length).toBe(100);
    });

    it('should handle negative relativeMs gracefully', async () => {
      const eventsWithNegative: RecordedEvent[] = [
        { ...sampleEvents[0], relativeMs: 0 },
        { ...sampleEvents[1], relativeMs: -50 }, // Negative delay
      ];

      vi.mocked(fs.readFileSync).mockReturnValue(createJsonlContent(eventsWithNegative));

      const eventSpy = vi.fn();
      service.on('event', eventSpy);

      service.startPlayback('/path/to/negative.jsonl', { speed: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0); // Math.max(0, delay) ensures non-negative

      expect(eventSpy).toHaveBeenCalledTimes(2);
    });
  });
});
