import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkAllServices } from '../service-health';
import { Kafka } from 'kafkajs';

// Mock dependencies
const mockDb = {
  execute: vi.fn(),
};

vi.mock('../storage', () => ({
  getIntelligenceDb: vi.fn(() => mockDb),
  tryGetIntelligenceDb: vi.fn(() => mockDb),
  isDatabaseConfigured: vi.fn(() => true),
  getDatabaseError: vi.fn(() => null),
}));

vi.mock('kafkajs', () => ({
  Kafka: vi.fn(),
}));

// Stub for legacy eventConsumer references in test assertions.
// service-health.ts no longer imports EventConsumer (uses DB watermarks).
const eventConsumer = {
  getHealthStatus: vi.fn(),
};

// Mock global fetch
global.fetch = vi.fn();

describe('Service Health Checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set required environment variables for Kafka connection tests
    process.env.KAFKA_BROKERS = 'localhost:9092';
    process.env.KAFKA_BOOTSTRAP_SERVERS = 'localhost:9092';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up environment variables
    delete process.env.KAFKA_BROKERS;
    delete process.env.KAFKA_BOOTSTRAP_SERVERS;
  });

  // Note: Individual check functions are not exported, so we test via checkAllServices
  // or we can test the exported checkAllServices function which calls them all
  describe('checkPostgreSQL (via checkAllServices)', () => {
    it('should return up status when database is healthy', async () => {
      const mockResult = [
        {
          check: 1,
          current_time: new Date(),
          pg_version: 'PostgreSQL 15.0',
        },
      ];

      vi.mocked(mockDb.execute).mockResolvedValue(mockResult as any);

      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(Kafka).mockImplementation(function () {
        return {
          admin: () => mockAdmin,
        } as any;
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
      } as any);

      vi.mocked(eventConsumer.getHealthStatus).mockReturnValue({
        status: 'healthy',
      } as any);

      const results = await checkAllServices();
      const pgResult = results.find((r) => r.service === 'PostgreSQL');

      expect(pgResult).toBeDefined();
      expect(pgResult?.status).toBe('up');
      expect(pgResult?.latencyMs).toBeGreaterThanOrEqual(0);
      expect(pgResult?.details).toBeDefined();
      expect(pgResult?.details?.version).toBeDefined();
    });

    it('should return down status when database connection fails', async () => {
      vi.mocked(mockDb.execute).mockRejectedValue(new Error('Connection refused'));

      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(Kafka).mockImplementation(function () {
        return {
          admin: () => mockAdmin,
        } as any;
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
      } as any);

      vi.mocked(eventConsumer.getHealthStatus).mockReturnValue({
        status: 'healthy',
      } as any);

      const results = await checkAllServices();
      const pgResult = results.find((r) => r.service === 'PostgreSQL');

      expect(pgResult).toBeDefined();
      expect(pgResult?.status).toBe('down');
      expect(pgResult?.error).toBeDefined();
      expect(pgResult?.error).toContain('Connection refused');
    });
  });

  describe('checkKafka (via checkAllServices)', () => {
    it('should return down status when KAFKA_BROKERS not configured', async () => {
      // Remove environment variables to test validation
      delete process.env.KAFKA_BROKERS;
      delete process.env.KAFKA_BOOTSTRAP_SERVERS;

      vi.mocked(mockDb.execute).mockResolvedValue([{ check: 1 }] as any);

      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(Kafka).mockImplementation(function () {
        return {
          admin: () => mockAdmin,
        } as any;
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
      } as any);

      vi.mocked(eventConsumer.getHealthStatus).mockReturnValue({
        status: 'healthy',
      } as any);

      const results = await checkAllServices();
      const kafkaResult = results.find((r) => r.service === 'Kafka/Redpanda');

      expect(kafkaResult).toBeDefined();
      expect(kafkaResult?.status).toBe('down');
      expect(kafkaResult?.error).toContain('environment variable not configured');
      expect(kafkaResult?.details?.message).toContain('Set KAFKA_BOOTSTRAP_SERVERS in .env file');

      // Restore environment variables for subsequent tests
      process.env.KAFKA_BROKERS = 'localhost:9092';
      process.env.KAFKA_BOOTSTRAP_SERVERS = 'localhost:9092';
    });

    it('should return up status when Kafka is healthy', async () => {
      vi.mocked(mockDb.execute).mockResolvedValue([{ check: 1 }] as any);

      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockResolvedValue(['topic1', 'topic2', 'topic3']),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(Kafka).mockImplementation(function () {
        return {
          admin: () => mockAdmin,
        } as any;
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
      } as any);

      vi.mocked(eventConsumer.getHealthStatus).mockReturnValue({
        status: 'healthy',
      } as any);

      const results = await checkAllServices();
      const kafkaResult = results.find((r) => r.service === 'Kafka/Redpanda');

      expect(kafkaResult).toBeDefined();
      expect(kafkaResult?.status).toBe('up');
      expect(kafkaResult?.latencyMs).toBeGreaterThanOrEqual(0);
      expect(kafkaResult?.details?.topicCount).toBe(3);
      expect(mockAdmin.connect).toHaveBeenCalled();
      expect(mockAdmin.listTopics).toHaveBeenCalled();
      expect(mockAdmin.disconnect).toHaveBeenCalled();
    });

    it('should return down status when Kafka connection fails', async () => {
      vi.mocked(mockDb.execute).mockResolvedValue([{ check: 1 }] as any);

      const mockAdmin = {
        connect: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };

      vi.mocked(Kafka).mockImplementation(function () {
        return {
          admin: () => mockAdmin,
        } as any;
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
      } as any);

      vi.mocked(eventConsumer.getHealthStatus).mockReturnValue({
        status: 'healthy',
      } as any);

      const results = await checkAllServices();
      const kafkaResult = results.find((r) => r.service === 'Kafka/Redpanda');

      expect(kafkaResult).toBeDefined();
      expect(kafkaResult?.status).toBe('down');
      expect(kafkaResult?.error).toBeDefined();
      expect(kafkaResult?.error).toContain('Connection refused');
    });
  });

  describe('checkEventConsumer / DB watermark (via checkAllServices)', () => {
    it('should return up status when watermarks show recent activity', async () => {
      // checkEventConsumer now queries projection_watermarks table (DB watermarks).
      // Return DB connectivity check first, then watermark rows.
      const recentDate = new Date().toISOString();
      const watermarkRows = [
        { projection_name: 'topic-a:0', last_offset: '100', updated_at: recentDate },
        { projection_name: 'topic-b:0', last_offset: '200', updated_at: recentDate },
        { projection_name: 'topic-c:0', last_offset: '50', updated_at: recentDate },
      ];
      vi.mocked(mockDb.execute).mockResolvedValue({ rows: watermarkRows } as any);

      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(Kafka).mockImplementation(function () {
        return {
          admin: () => mockAdmin,
        } as any;
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
      } as any);

      const results = await checkAllServices();
      const eventConsumerResult = results.find((r) => r.service === 'Event Consumer');

      expect(eventConsumerResult).toBeDefined();
      expect(eventConsumerResult?.status).toBe('up');
    });

    it('should return down status when no watermark rows exist', async () => {
      vi.mocked(mockDb.execute).mockResolvedValue({ rows: [] } as any);

      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(Kafka).mockImplementation(function () {
        return {
          admin: () => mockAdmin,
        } as any;
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
      } as any);

      const results = await checkAllServices();
      const eventConsumerResult = results.find((r) => r.service === 'Event Consumer');

      expect(eventConsumerResult).toBeDefined();
      expect(eventConsumerResult?.status).toBe('down');
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockDb.execute).mockRejectedValue(new Error('DB connection failed'));

      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(Kafka).mockImplementation(function () {
        return {
          admin: () => mockAdmin,
        } as any;
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
      } as any);

      const results = await checkAllServices();
      const eventConsumerResult = results.find((r) => r.service === 'Event Consumer');

      expect(eventConsumerResult).toBeDefined();
      expect(eventConsumerResult?.status).toBe('down');
      expect(eventConsumerResult?.error).toBeDefined();
    });
  });

  describe('checkKeycloak', () => {
    it('should return configured: false when KEYCLOAK_ISSUER is not set', async () => {
      delete process.env.KEYCLOAK_ISSUER;

      const results = await checkAllServices();
      const keycloak = results.find((r) => r.service === 'Keycloak');

      expect(keycloak).toBeDefined();
      expect(keycloak!.status).toBe('down');
      expect(keycloak!.details?.configured).toBe(false);
    });

    it('should return up when OIDC discovery succeeds', async () => {
      process.env.KEYCLOAK_ISSUER = 'http://localhost:8080/realms/test';

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          issuer: 'http://localhost:8080/realms/test',
          authorization_endpoint: 'http://localhost:8080/realms/test/protocol/openid-connect/auth',
        }),
      } as any);

      // Need other mocks for checkAllServices
      vi.mocked(mockDb.execute).mockResolvedValue([{ check: 1 }] as any);
      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(Kafka).mockImplementation(function () {
        return { admin: () => mockAdmin } as any;
      });
      vi.mocked(eventConsumer.getHealthStatus).mockReturnValue({ status: 'healthy' } as any);

      const results = await checkAllServices();
      const keycloak = results.find((r) => r.service === 'Keycloak');

      expect(keycloak).toBeDefined();
      expect(keycloak!.status).toBe('up');
      expect(keycloak!.details?.configured).toBe(true);
      expect(keycloak!.details?.issuer).toBe('http://localhost:8080/realms/test');

      delete process.env.KEYCLOAK_ISSUER;
    });

    it('should return down when OIDC discovery fails', async () => {
      process.env.KEYCLOAK_ISSUER = 'http://localhost:8080/realms/test';

      vi.mocked(global.fetch).mockRejectedValue(new Error('Connection refused'));

      vi.mocked(mockDb.execute).mockResolvedValue([{ check: 1 }] as any);
      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(Kafka).mockImplementation(function () {
        return { admin: () => mockAdmin } as any;
      });
      vi.mocked(eventConsumer.getHealthStatus).mockReturnValue({ status: 'healthy' } as any);

      const results = await checkAllServices();
      const keycloak = results.find((r) => r.service === 'Keycloak');

      expect(keycloak).toBeDefined();
      expect(keycloak!.status).toBe('down');
      expect(keycloak!.details?.configured).toBe(true);
      expect(keycloak!.error).toBe('Connection refused');

      delete process.env.KEYCLOAK_ISSUER;
    });
  });

  describe('checkAllServices', () => {
    it('should check all services and return array of results', async () => {
      // Mock all service checks
      vi.mocked(mockDb.execute).mockResolvedValue([{ check: 1 }] as any);

      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(Kafka).mockImplementation(function () {
        return {
          admin: () => mockAdmin,
        } as any;
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
      } as any);

      vi.mocked(eventConsumer.getHealthStatus).mockReturnValue({
        status: 'healthy',
      } as any);

      const results = await checkAllServices();

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(4);
      expect(results[0].service).toBe('PostgreSQL');
      expect(results[1].service).toBe('Kafka/Redpanda');
      expect(results[2].service).toBe('Event Consumer');
      expect(results[3].service).toBe('Keycloak');
    });
  });
});
