import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TOPIC_OMNICLAUDE_ROUTING_DECISIONS, TOPIC_OMNICLAUDE_AGENT_ACTIONS } from '@shared/topics';

// Ensure NODE_ENV and VITEST are set for these tests
process.env.NODE_ENV = 'test';
process.env.VITEST = 'true';
// Set Kafka environment variables required for tests
process.env.KAFKA_BROKERS = 'localhost:9092';
process.env.KAFKA_BOOTSTRAP_SERVERS = 'localhost:9092';

const connectMock = vi.fn();
const sendMock = vi.fn();
const disconnectMock = vi.fn();
const producerMock = {
  connect: connectMock,
  send: sendMock,
  disconnect: disconnectMock,
};
const kafkaInstanceMock = {
  producer: vi.fn(() => producerMock),
};

vi.mock('kafkajs', () => ({
  Kafka: vi.fn(() => kafkaInstanceMock),
}));

describe('MockEventGenerator', () => {
  let MockEventGenerator: typeof import('../test/mock-event-generator').MockEventGenerator;

  beforeEach(async () => {
    vi.restoreAllMocks();
    connectMock.mockResolvedValue(undefined);
    sendMock.mockResolvedValue(undefined);
    disconnectMock.mockResolvedValue(undefined);
    kafkaInstanceMock.producer = vi.fn(() => producerMock);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    ({ MockEventGenerator } = await import('../test/mock-event-generator'));
  });

  afterEach(() => {
    vi.useRealTimers(); // Clean up timers after each test
    vi.restoreAllMocks();
  });

  it('connects, publishes initial batch, and disconnects on start', async () => {
    const generator = new MockEventGenerator();

    await generator.start({ continuous: false, initialBatch: 5 });

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(5);
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  it('publishes routing and action events during random generation', async () => {
    const generator = new MockEventGenerator();
    sendMock.mockClear();

    await generator.publishRandomEvents();

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0].topic).toBe(TOPIC_OMNICLAUDE_ROUTING_DECISIONS);
    expect(sendMock.mock.calls[1][0].topic).toBe(TOPIC_OMNICLAUDE_AGENT_ACTIONS);
  });

  it('clears interval and disconnects on stop', async () => {
    vi.useFakeTimers();

    const generator = new MockEventGenerator();

    // Simulate running state
    (generator as any).isRunning = true;
    (generator as any).intervalId = setInterval(() => {}, 1000);

    await generator.stop();

    expect(disconnectMock).toHaveBeenCalled();
    expect((generator as any).intervalId).toBeUndefined();

    vi.useRealTimers();
  });
});
