import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const registerRoutesMock = vi.fn();
const setupViteMock = vi.fn();
const serveStaticMock = vi.fn();
const logMock = vi.fn();
const setupWebSocketMock = vi.fn();
const validateConnectionMock = vi.fn();
const startMock = vi.fn();
const stopMock = vi.fn();
const eventBusValidateConnectionMock = vi.fn();
const eventBusStartMock = vi.fn();
const eventBusStopMock = vi.fn();
const eventBusInitializeSchemaMock = vi.fn();
const eventBusIsActiveMock = vi.fn();
const mockGeneratorStartMock = vi.fn();
const mockGeneratorStopMock = vi.fn();

vi.mock('../auth/oidc-client', () => ({
  initOidcClient: vi.fn().mockResolvedValue(undefined),
  isAuthEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../auth/session-config', () => ({
  configureSession: vi.fn().mockResolvedValue(undefined),
  getSessionMiddleware: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../auth/auth-routes', () => ({
  authRoutes: (_req: any, _res: any, next: any) => next(),
  authMeRoute: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../auth/middleware', () => ({
  refreshTokenIfNeeded: (_req: any, _res: any, next: any) => next(),
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../routes', () => ({
  registerRoutes: registerRoutesMock,
}));

vi.mock('../vite', () => ({
  setupVite: setupViteMock,
  serveStatic: serveStaticMock,
  log: logMock,
}));

vi.mock('../websocket', () => ({
  setupWebSocket: setupWebSocketMock,
}));

vi.mock('../projections/node-registry-projection', () => ({
  NodeRegistryProjection: vi.fn().mockImplementation(() => ({
    viewId: 'node-registry',
  })),
}));

vi.mock('../projection-routes', () => ({
  createProjectionRoutes: vi.fn(),
}));

vi.mock('../projection-instance', () => ({
  initProjectionListeners: vi.fn(),
  teardownProjectionListeners: vi.fn(),
}));

const eventConsumerOnMock = vi.fn().mockReturnThis();
const getRegisteredNodesMock = vi.fn().mockReturnValue([]);

vi.mock('../event-consumer', () => ({
  eventConsumer: {
    validateConnection: validateConnectionMock,
    start: startMock,
    stop: stopMock,
    on: eventConsumerOnMock,
    removeListener: vi.fn(),
    getRegisteredNodes: getRegisteredNodesMock,
  },
}));

vi.mock('../event-bus-data-source', () => ({
  eventBusDataSource: {
    validateConnection: eventBusValidateConnectionMock,
    start: eventBusStartMock,
    stop: eventBusStopMock,
    initializeSchema: eventBusInitializeSchemaMock,
    isActive: eventBusIsActiveMock,
  },
}));

vi.mock('../event-bus-mock-generator', () => ({
  eventBusMockGenerator: {
    start: mockGeneratorStartMock,
    stop: mockGeneratorStopMock,
  },
}));

const projectionServiceMock = {
  registerView: vi.fn(),
  getView: vi.fn().mockReturnValue(undefined),
  ingest: vi.fn(),
  on: vi.fn(),
};

vi.mock('../projection-bootstrap', () => ({
  wireProjectionSources: vi.fn(),
  projectionService: projectionServiceMock,
}));

vi.mock('../read-model-consumer', () => ({
  readModelConsumer: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStats: vi
      .fn()
      .mockReturnValue({
        isRunning: false,
        eventsProjected: 0,
        errorsCount: 0,
        lastProjectedAt: null,
        topicStats: {},
      }),
  },
}));

describe('server/index bootstrap', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let mockServer: any;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    originalEnv = { ...process.env };

    mockServer = {
      listen: vi.fn((_port: number, _host: string, cb?: () => void) => {
        cb?.();
        return mockServer;
      }),
      close: vi.fn((cb?: () => void) => {
        cb?.();
        return mockServer;
      }),
    };

    registerRoutesMock.mockResolvedValue(mockServer);
    validateConnectionMock.mockResolvedValue(true);
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);
    eventBusValidateConnectionMock.mockResolvedValue(true);
    eventBusStartMock.mockResolvedValue(undefined);
    eventBusStopMock.mockResolvedValue(undefined);
    eventBusInitializeSchemaMock.mockResolvedValue(undefined);
    eventBusIsActiveMock.mockReturnValue(true);
    mockGeneratorStartMock.mockResolvedValue(undefined);
    mockGeneratorStopMock.mockReturnValue(undefined);

    processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    processOnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  async function importIndex() {
    await import('../index');
    // Allow pending microtasks to resolve
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('starts services with realtime events enabled in development', async () => {
    process.env.NODE_ENV = 'development';
    process.env.PORT = '4001';
    process.env.ENABLE_REAL_TIME_EVENTS = 'true';

    await importIndex();

    expect(registerRoutesMock).toHaveBeenCalledTimes(1);
    expect(validateConnectionMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(setupWebSocketMock).toHaveBeenCalledWith(mockServer);
    expect(setupViteMock).toHaveBeenCalledWith(expect.anything(), mockServer);
    expect(serveStaticMock).not.toHaveBeenCalled();
    expect(mockServer.listen).toHaveBeenCalledWith(4001, '0.0.0.0', expect.any(Function));
    expect(logMock).toHaveBeenCalledWith('serving on port 4001');
    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('falls back to serveStatic when realtime events disabled or unavailable', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_REAL_TIME_EVENTS = 'false';
    delete process.env.PORT;

    validateConnectionMock.mockResolvedValueOnce(false);

    await importIndex();

    expect(startMock).not.toHaveBeenCalled();
    // WebSocket only set up when ENABLE_REAL_TIME_EVENTS=true
    expect(setupWebSocketMock).not.toHaveBeenCalled();
    expect(setupViteMock).not.toHaveBeenCalled();
    expect(serveStaticMock).toHaveBeenCalledWith(expect.anything());
    expect(mockServer.listen).toHaveBeenCalledWith(3000, '0.0.0.0', expect.any(Function));
  });

  it('logs and continues when event consumer fails to start', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_REAL_TIME_EVENTS = 'true';
    validateConnectionMock.mockResolvedValueOnce(true);
    const failure = new Error('broker unavailable');
    startMock.mockRejectedValueOnce(failure);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await importIndex();

    expect(validateConnectionMock).toHaveBeenCalled();
    expect(startMock).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('❌ Failed to start event consumer:', failure);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '   Intelligence endpoints will not receive real-time data'
    );
    expect(setupWebSocketMock).toHaveBeenCalledWith(mockServer);

    consoleErrorSpy.mockRestore();
  });

  it('registers NodeRegistryProjection before registerRoutes', async () => {
    process.env.NODE_ENV = 'development';

    const callOrder: string[] = [];
    projectionServiceMock.registerView.mockImplementation(() => {
      callOrder.push('registerView');
    });
    registerRoutesMock.mockImplementation(async () => {
      callOrder.push('registerRoutes');
      return mockServer;
    });

    await importIndex();

    const viewIdx = callOrder.indexOf('registerView');
    const routesIdx = callOrder.indexOf('registerRoutes');
    expect(viewIdx).toBeGreaterThanOrEqual(0);
    expect(routesIdx).toBeGreaterThanOrEqual(0);
    expect(viewIdx).toBeLessThan(routesIdx);
  });
});
