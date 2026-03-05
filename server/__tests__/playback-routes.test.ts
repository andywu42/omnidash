import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { TOPIC_OMNICLAUDE_AGENT_ACTIONS } from '@shared/topics';

// Define mock types
interface MockPlaybackService {
  listRecordings: Mock;
  getStatus: Mock;
  startPlayback: Mock;
  pausePlayback: Mock;
  resumePlayback: Mock;
  stopPlayback: Mock;
  setSpeed: Mock;
  setLoop: Mock;
  on: Mock;
  off: Mock;
}

interface MockEventConsumer {
  resetState: Mock;
  injectPlaybackEvent: Mock;
  snapshotState: Mock;
  restoreState: Mock;
  hasStateSnapshot: Mock;
}

interface MockPlaybackDataSource {
  injectPlaybackEvent: Mock;
  injectEvent: Mock;
  start: Mock;
  stop: Mock;
  isRunning: Mock;
  on: Mock;
  off: Mock;
  emit: Mock;
}

// DEMO_MODE is captured as a module-level constant in playback-routes.ts.
// Setting it here inside vi.hoisted() ensures it is set before the static
// import of playbackRouter at line 98, enabling state-mutating routes in tests.
vi.hoisted(() => {
  process.env.DEMO_MODE = 'true';
});

// Use vi.hoisted to define mocks that will be available during module mocking
const { mockPlaybackService, mockEventConsumer, mockPlaybackDataSource } = vi.hoisted(() => {
  const mockPlaybackService: MockPlaybackService = {
    listRecordings: vi.fn(),
    getStatus: vi.fn(),
    startPlayback: vi.fn(),
    pausePlayback: vi.fn(),
    resumePlayback: vi.fn(),
    stopPlayback: vi.fn(),
    setSpeed: vi.fn(),
    setLoop: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };

  const mockEventConsumer: MockEventConsumer = {
    resetState: vi.fn(),
    injectPlaybackEvent: vi.fn(),
    snapshotState: vi.fn(),
    restoreState: vi.fn().mockReturnValue(true),
    hasStateSnapshot: vi.fn().mockReturnValue(false),
  };

  const mockPlaybackDataSource: MockPlaybackDataSource = {
    injectPlaybackEvent: vi.fn(),
    injectEvent: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };

  return { mockPlaybackService, mockEventConsumer, mockPlaybackDataSource };
});

// Mock event-playback module
vi.mock('../event-playback', () => ({
  getPlaybackService: () => mockPlaybackService,
  playbackLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock event-consumer module
vi.mock('../event-consumer', () => ({
  getEventConsumer: () => mockEventConsumer,
}));

// Mock playback-data-source module
vi.mock('../playback-data-source', () => ({
  getPlaybackDataSource: () => mockPlaybackDataSource,
}));

// Import router after mocks are set up
import playbackRouter from '../playback-routes';

describe('Playback Routes', () => {
  let app: Express;

  beforeEach(() => {
    // Create fresh Express app for each test
    app = express();
    app.use(express.json());
    app.use('/api/demo', playbackRouter);

    // Reset all mocks
    vi.clearAllMocks();

    // Set up default mock return values
    mockPlaybackService.getStatus.mockReturnValue({
      isPlaying: false,
      isPaused: false,
      currentIndex: 0,
      totalEvents: 0,
      progress: 0,
      recordingFile: '',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/demo/recordings', () => {
    it('should return list of available recordings', async () => {
      const mockRecordings = [
        {
          name: 'test-recording.jsonl',
          path: '/demo/recordings/test-recording.jsonl',
          size: 1024,
          eventCount: 50,
        },
        {
          name: 'demo-events.jsonl',
          size: 2048,
          eventCount: 100,
        },
      ];
      mockPlaybackService.listRecordings.mockReturnValue(mockRecordings);

      const response = await request(app).get('/api/demo/recordings').expect(200);

      expect(response.body).toEqual({
        success: true,
        recordings: mockRecordings,
      });
      expect(mockPlaybackService.listRecordings).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no recordings exist', async () => {
      mockPlaybackService.listRecordings.mockReturnValue([]);

      const response = await request(app).get('/api/demo/recordings').expect(200);

      expect(response.body).toEqual({
        success: true,
        recordings: [],
      });
    });

    it('should handle errors and return 500 status', async () => {
      mockPlaybackService.listRecordings.mockImplementation(() => {
        throw new Error('Failed to read recordings directory');
      });

      const response = await request(app).get('/api/demo/recordings').expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to read recordings directory',
      });
    });

    it('should handle non-Error exceptions', async () => {
      mockPlaybackService.listRecordings.mockImplementation(() => {
        throw 'Unknown failure';
      });

      const response = await request(app).get('/api/demo/recordings').expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Unknown error',
      });
    });
  });

  describe('GET /api/demo/status', () => {
    it('should return current playback status when idle', async () => {
      const mockStatus = {
        isPlaying: false,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 0,
        progress: 0,
        recordingFile: '',
      };
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      const response = await request(app).get('/api/demo/status').expect(200);

      expect(response.body).toEqual({
        success: true,
        ...mockStatus,
      });
      expect(mockPlaybackService.getStatus).toHaveBeenCalledTimes(1);
    });

    it('should return current playback status when playing', async () => {
      const mockStatus = {
        isPlaying: true,
        isPaused: false,
        currentIndex: 25,
        totalEvents: 100,
        progress: 25,
        recordingFile: '/demo/recordings/test.jsonl',
      };
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      const response = await request(app).get('/api/demo/status').expect(200);

      expect(response.body).toEqual({
        success: true,
        ...mockStatus,
      });
    });

    it('should return current playback status when paused', async () => {
      const mockStatus = {
        isPlaying: true,
        isPaused: true,
        currentIndex: 50,
        totalEvents: 100,
        progress: 50,
        recordingFile: '/demo/recordings/test.jsonl',
      };
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      const response = await request(app).get('/api/demo/status').expect(200);

      expect(response.body.isPaused).toBe(true);
      expect(response.body.isPlaying).toBe(true);
    });
  });

  describe('POST /api/demo/start', () => {
    it('should start playback with valid file', async () => {
      const mockStatus = {
        isPlaying: true,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 100,
        progress: 0,
        recordingFile: '/demo/recordings/test-events.jsonl',
      };
      mockPlaybackService.startPlayback.mockResolvedValue(undefined);
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      const response = await request(app)
        .post('/api/demo/start')
        .send({ file: 'test-events.jsonl' })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Playback started',
        ...mockStatus,
      });
      expect(mockPlaybackService.startPlayback).toHaveBeenCalledTimes(1);
      expect(mockEventConsumer.resetState).toHaveBeenCalledTimes(1);
    });

    it('should start playback with custom speed', async () => {
      mockPlaybackService.startPlayback.mockResolvedValue(undefined);
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: true,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 50,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      const response = await request(app)
        .post('/api/demo/start')
        .send({ file: 'test.jsonl', speed: 2 })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockPlaybackService.startPlayback).toHaveBeenCalledWith(
        expect.stringContaining('demo/recordings/test.jsonl'),
        expect.objectContaining({ speed: 2 })
      );
    });

    it('should start playback with loop option', async () => {
      mockPlaybackService.startPlayback.mockResolvedValue(undefined);
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: true,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 50,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      const response = await request(app)
        .post('/api/demo/start')
        .send({ file: 'test.jsonl', loop: true })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockPlaybackService.startPlayback).toHaveBeenCalledWith(
        expect.stringContaining('demo/recordings/test.jsonl'),
        expect.objectContaining({ loop: true })
      );
    });

    it('should return 400 when file is missing', async () => {
      const response = await request(app).post('/api/demo/start').send({}).expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Missing required field: file',
      });
      expect(mockPlaybackService.startPlayback).not.toHaveBeenCalled();
    });

    it('should return 400 when file is empty string', async () => {
      const response = await request(app).post('/api/demo/start').send({ file: '' }).expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Missing required field: file',
      });
    });

    // Security: Path traversal prevention tests
    it('should reject path traversal attack using ../', async () => {
      const response = await request(app)
        .post('/api/demo/start')
        .send({ file: '../../../etc/passwd' })
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        error: 'Access denied: invalid file path',
      });
      expect(mockPlaybackService.startPlayback).not.toHaveBeenCalled();
    });

    it('should reject path traversal attack using absolute path', async () => {
      const response = await request(app)
        .post('/api/demo/start')
        .send({ file: '/etc/passwd' })
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        error: 'Access denied: invalid file path',
      });
      expect(mockPlaybackService.startPlayback).not.toHaveBeenCalled();
    });

    it('should reject path traversal attack using encoded ../', async () => {
      const response = await request(app)
        .post('/api/demo/start')
        .send({ file: '..%2F..%2Fetc%2Fpasswd' })
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        error: 'Access denied: invalid file path',
      });
    });

    it('should reject path traversal attack with dot-dot in filename', async () => {
      const response = await request(app)
        .post('/api/demo/start')
        .send({ file: './../../etc/passwd' })
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        error: 'Access denied: invalid file path',
      });
    });

    it('should reject absolute path outside recordings directory', async () => {
      const response = await request(app)
        .post('/api/demo/start')
        .send({ file: '/tmp/malicious.jsonl' })
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        error: 'Access denied: invalid file path',
      });
    });

    it('should handle startPlayback errors gracefully', async () => {
      mockPlaybackService.startPlayback.mockRejectedValue(new Error('Recording file not found'));

      const response = await request(app)
        .post('/api/demo/start')
        .send({ file: 'nonexistent.jsonl' })
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Recording file not found',
      });
    });

    it('should handle non-Error exceptions in startPlayback', async () => {
      mockPlaybackService.startPlayback.mockRejectedValue('Unknown playback error');

      const response = await request(app)
        .post('/api/demo/start')
        .send({ file: 'test.jsonl' })
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Unknown error',
      });
    });

    it('should register event handler on playback service', async () => {
      mockPlaybackService.startPlayback.mockResolvedValue(undefined);
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: true,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 100,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      await request(app).post('/api/demo/start').send({ file: 'test.jsonl' }).expect(200);

      expect(mockPlaybackService.on).toHaveBeenCalledWith('event', expect.any(Function));
    });

    it('should use default speed of 1 when not specified', async () => {
      mockPlaybackService.startPlayback.mockResolvedValue(undefined);
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: true,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 50,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      await request(app).post('/api/demo/start').send({ file: 'test.jsonl' }).expect(200);

      expect(mockPlaybackService.startPlayback).toHaveBeenCalledWith(
        expect.stringContaining('demo/recordings/test.jsonl'),
        expect.objectContaining({ speed: 1, loop: false })
      );
    });
  });

  describe('POST /api/demo/pause', () => {
    it('should pause playback and return status', async () => {
      const mockStatus = {
        isPlaying: true,
        isPaused: true,
        currentIndex: 25,
        totalEvents: 100,
        progress: 25,
        recordingFile: '/demo/recordings/test.jsonl',
      };
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      const response = await request(app).post('/api/demo/pause').expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Playback paused',
        ...mockStatus,
      });
      expect(mockPlaybackService.pausePlayback).toHaveBeenCalledTimes(1);
    });

    it('should be idempotent when already paused', async () => {
      const mockStatus = {
        isPlaying: true,
        isPaused: true,
        currentIndex: 25,
        totalEvents: 100,
        progress: 25,
        recordingFile: '/demo/recordings/test.jsonl',
      };
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      // Call pause twice
      await request(app).post('/api/demo/pause').expect(200);
      const response = await request(app).post('/api/demo/pause').expect(200);

      expect(response.body.success).toBe(true);
      expect(mockPlaybackService.pausePlayback).toHaveBeenCalledTimes(2);
    });
  });

  describe('POST /api/demo/resume', () => {
    it('should resume playback and return status', async () => {
      const mockStatus = {
        isPlaying: true,
        isPaused: false,
        currentIndex: 25,
        totalEvents: 100,
        progress: 25,
        recordingFile: '/demo/recordings/test.jsonl',
      };
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      const response = await request(app).post('/api/demo/resume').expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Playback resumed',
        ...mockStatus,
      });
      expect(mockPlaybackService.resumePlayback).toHaveBeenCalledTimes(1);
    });

    it('should be idempotent when already playing', async () => {
      const mockStatus = {
        isPlaying: true,
        isPaused: false,
        currentIndex: 50,
        totalEvents: 100,
        progress: 50,
        recordingFile: '/demo/recordings/test.jsonl',
      };
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      await request(app).post('/api/demo/resume').expect(200);
      const response = await request(app).post('/api/demo/resume').expect(200);

      expect(response.body.success).toBe(true);
      expect(mockPlaybackService.resumePlayback).toHaveBeenCalledTimes(2);
    });
  });

  describe('POST /api/demo/stop', () => {
    it('should stop playback and return status', async () => {
      const mockStatus = {
        isPlaying: false,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 100,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      };
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      const response = await request(app).post('/api/demo/stop').expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Playback stopped',
        ...mockStatus,
      });
      expect(mockPlaybackService.stopPlayback).toHaveBeenCalledTimes(1);
    });

    it('should be safe to call when not playing', async () => {
      const mockStatus = {
        isPlaying: false,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 0,
        progress: 0,
        recordingFile: '',
      };
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      const response = await request(app).post('/api/demo/stop').expect(200);

      expect(response.body.success).toBe(true);
      expect(mockPlaybackService.stopPlayback).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/demo/speed', () => {
    it('should set valid speed and return status', async () => {
      const mockStatus = {
        isPlaying: true,
        isPaused: false,
        currentIndex: 25,
        totalEvents: 100,
        progress: 25,
        recordingFile: '/demo/recordings/test.jsonl',
      };
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      const response = await request(app).post('/api/demo/speed').send({ speed: 2 }).expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Speed set to 2x',
        ...mockStatus,
      });
      expect(mockPlaybackService.setSpeed).toHaveBeenCalledWith(2);
    });

    it('should accept speed of 0 (instant mode)', async () => {
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: true,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 100,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      const response = await request(app).post('/api/demo/speed').send({ speed: 0 }).expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Speed set to 0x');
      expect(mockPlaybackService.setSpeed).toHaveBeenCalledWith(0);
    });

    it('should accept speed of 0.5 (half speed)', async () => {
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: true,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 100,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      const response = await request(app).post('/api/demo/speed').send({ speed: 0.5 }).expect(200);

      expect(response.body.success).toBe(true);
      expect(mockPlaybackService.setSpeed).toHaveBeenCalledWith(0.5);
    });

    it('should accept maximum speed of 100', async () => {
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: true,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 100,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      const response = await request(app).post('/api/demo/speed').send({ speed: 100 }).expect(200);

      expect(response.body.success).toBe(true);
      expect(mockPlaybackService.setSpeed).toHaveBeenCalledWith(100);
    });

    it('should reject speed exceeding maximum', async () => {
      const response = await request(app).post('/api/demo/speed').send({ speed: 101 }).expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid speed value');
      expect(mockPlaybackService.setSpeed).not.toHaveBeenCalled();
    });

    it('should reject negative speed', async () => {
      const response = await request(app).post('/api/demo/speed').send({ speed: -1 }).expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid speed value');
      expect(mockPlaybackService.setSpeed).not.toHaveBeenCalled();
    });

    it('should reject non-numeric speed', async () => {
      const response = await request(app)
        .post('/api/demo/speed')
        .send({ speed: 'fast' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid speed value');
      expect(mockPlaybackService.setSpeed).not.toHaveBeenCalled();
    });

    it('should reject missing speed parameter', async () => {
      const response = await request(app).post('/api/demo/speed').send({}).expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid speed value');
      expect(mockPlaybackService.setSpeed).not.toHaveBeenCalled();
    });

    it('should reject null speed', async () => {
      const response = await request(app).post('/api/demo/speed').send({ speed: null }).expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid speed value');
      expect(mockPlaybackService.setSpeed).not.toHaveBeenCalled();
    });

    it('should reject NaN speed', async () => {
      const response = await request(app).post('/api/demo/speed').send({ speed: NaN }).expect(400);

      expect(response.body.success).toBe(false);
      expect(mockPlaybackService.setSpeed).not.toHaveBeenCalled();
    });

    it('should reject Infinity speed', async () => {
      const response = await request(app)
        .post('/api/demo/speed')
        .send({ speed: Infinity })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(mockPlaybackService.setSpeed).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/demo/loop', () => {
    it('should set loop enabled and return status', async () => {
      const mockStatus = {
        isPlaying: true,
        isPaused: false,
        currentIndex: 25,
        totalEvents: 100,
        progress: 25,
        recordingFile: '/demo/recordings/test.jsonl',
      };
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      const response = await request(app).post('/api/demo/loop').send({ loop: true }).expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Loop enabled',
        ...mockStatus,
      });
      expect(mockPlaybackService.setLoop).toHaveBeenCalledWith(true);
    });

    it('should set loop disabled and return status', async () => {
      const mockStatus = {
        isPlaying: true,
        isPaused: false,
        currentIndex: 50,
        totalEvents: 100,
        progress: 50,
        recordingFile: '/demo/recordings/test.jsonl',
      };
      mockPlaybackService.getStatus.mockReturnValue(mockStatus);

      const response = await request(app).post('/api/demo/loop').send({ loop: false }).expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Loop disabled',
        ...mockStatus,
      });
      expect(mockPlaybackService.setLoop).toHaveBeenCalledWith(false);
    });

    it('should reject string loop value', async () => {
      const response = await request(app).post('/api/demo/loop').send({ loop: 'true' }).expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid loop value. Must be a boolean',
      });
      expect(mockPlaybackService.setLoop).not.toHaveBeenCalled();
    });

    it('should reject numeric loop value', async () => {
      const response = await request(app).post('/api/demo/loop').send({ loop: 1 }).expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid loop value. Must be a boolean',
      });
      expect(mockPlaybackService.setLoop).not.toHaveBeenCalled();
    });

    it('should reject null loop value', async () => {
      const response = await request(app).post('/api/demo/loop').send({ loop: null }).expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid loop value. Must be a boolean',
      });
      expect(mockPlaybackService.setLoop).not.toHaveBeenCalled();
    });

    it('should reject missing loop parameter', async () => {
      const response = await request(app).post('/api/demo/loop').send({}).expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid loop value. Must be a boolean',
      });
      expect(mockPlaybackService.setLoop).not.toHaveBeenCalled();
    });

    it('should reject undefined loop value', async () => {
      const response = await request(app)
        .post('/api/demo/loop')
        .send({ loop: undefined })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid loop value. Must be a boolean',
      });
      expect(mockPlaybackService.setLoop).not.toHaveBeenCalled();
    });

    it('should reject object loop value', async () => {
      const response = await request(app)
        .post('/api/demo/loop')
        .send({ loop: { enabled: true } })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid loop value. Must be a boolean',
      });
      expect(mockPlaybackService.setLoop).not.toHaveBeenCalled();
    });

    it('should reject array loop value', async () => {
      const response = await request(app)
        .post('/api/demo/loop')
        .send({ loop: [true] })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid loop value. Must be a boolean',
      });
      expect(mockPlaybackService.setLoop).not.toHaveBeenCalled();
    });
  });

  describe('Event handler cleanup', () => {
    it('should remove previous event handler when starting new playback', async () => {
      mockPlaybackService.startPlayback.mockResolvedValue(undefined);
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: true,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 100,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      // Start first playback
      await request(app).post('/api/demo/start').send({ file: 'first.jsonl' }).expect(200);

      // Start second playback
      await request(app).post('/api/demo/start').send({ file: 'second.jsonl' }).expect(200);

      // Should have called off() to remove previous handler before adding new one
      expect(mockPlaybackService.off).toHaveBeenCalled();
    });

    it('should clean up event handler when stopping playback', async () => {
      mockPlaybackService.startPlayback.mockResolvedValue(undefined);
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: true,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 100,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      // Start playback
      await request(app).post('/api/demo/start').send({ file: 'test.jsonl' }).expect(200);

      // Stop playback
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: false,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 100,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      await request(app).post('/api/demo/stop').expect(200);

      // Should have cleaned up the event handler
      expect(mockPlaybackService.off).toHaveBeenCalledWith('event', expect.any(Function));
    });
  });

  describe('EventConsumer integration', () => {
    it('should reset EventConsumer state when starting playback', async () => {
      mockPlaybackService.startPlayback.mockResolvedValue(undefined);
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: true,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 100,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      await request(app).post('/api/demo/start').send({ file: 'test.jsonl' }).expect(200);

      expect(mockEventConsumer.resetState).toHaveBeenCalledTimes(1);
    });
  });

  describe('PlaybackDataSource integration', () => {
    it('should wire up event injection to PlaybackDataSource', async () => {
      mockPlaybackService.startPlayback.mockResolvedValue(undefined);
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: true,
        isPaused: false,
        currentIndex: 0,
        totalEvents: 100,
        progress: 0,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      await request(app).post('/api/demo/start').send({ file: 'test.jsonl' }).expect(200);

      // Verify the event handler was registered
      expect(mockPlaybackService.on).toHaveBeenCalledWith('event', expect.any(Function));

      // Get the registered handler
      const onCall = mockPlaybackService.on.mock.calls.find((call) => call[0] === 'event');
      expect(onCall).toBeDefined();

      const eventHandler = onCall![1] as (event: unknown) => void;

      // Simulate an event being emitted
      const testEvent = {
        topic: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        value: { action: 'test', timestamp: '2024-01-01T00:00:00Z' },
      };
      eventHandler(testEvent);

      // Verify the event was injected into PlaybackDataSource
      expect(mockPlaybackDataSource.injectPlaybackEvent).toHaveBeenCalledWith(
        TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        {
          action: 'test',
          timestamp: '2024-01-01T00:00:00Z',
        }
      );
    });
  });

  describe('Response structure validation', () => {
    it('recordings response should have correct structure', async () => {
      mockPlaybackService.listRecordings.mockReturnValue([
        { name: 'test.jsonl', size: 1024, eventCount: 100 },
      ]);

      const response = await request(app).get('/api/demo/recordings').expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('recordings');
      expect(Array.isArray(response.body.recordings)).toBe(true);
      if (response.body.recordings.length > 0) {
        const recording = response.body.recordings[0];
        expect(recording).toHaveProperty('name');
        expect(recording).toHaveProperty('size');
        expect(recording).toHaveProperty('eventCount');
        // Note: 'path' intentionally not included to avoid exposing server filesystem paths
      }
    });

    it('status response should have correct structure', async () => {
      mockPlaybackService.getStatus.mockReturnValue({
        isPlaying: true,
        isPaused: false,
        currentIndex: 50,
        totalEvents: 100,
        progress: 50,
        recordingFile: '/demo/recordings/test.jsonl',
      });

      const response = await request(app).get('/api/demo/status').expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('isPlaying');
      expect(response.body).toHaveProperty('isPaused');
      expect(response.body).toHaveProperty('currentIndex');
      expect(response.body).toHaveProperty('totalEvents');
      expect(response.body).toHaveProperty('progress');
      expect(response.body).toHaveProperty('recordingFile');
      expect(typeof response.body.isPlaying).toBe('boolean');
      expect(typeof response.body.isPaused).toBe('boolean');
      expect(typeof response.body.currentIndex).toBe('number');
      expect(typeof response.body.totalEvents).toBe('number');
      expect(typeof response.body.progress).toBe('number');
      expect(typeof response.body.recordingFile).toBe('string');
    });
  });
});
