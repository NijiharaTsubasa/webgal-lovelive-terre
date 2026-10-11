import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { GltfCatalogWorkerClient } from './gltf-catalog-worker-client';

jest.mock('worker_threads', () => ({ Worker: jest.fn() }));

describe('GltfCatalogWorkerClient', () => {
  let worker: EventEmitter & { postMessage: jest.Mock; terminate: jest.Mock };
  beforeEach(() => {
    jest.clearAllMocks();
    worker = Object.assign(new EventEmitter(), {
      postMessage: jest.fn(),
      terminate: jest.fn().mockResolvedValue(0),
    });
    (Worker as unknown as jest.Mock).mockImplementation(() => worker);
  });

  it('returns an immediate snapshot and publishes asynchronous index changes', async () => {
    const background = new GltfCatalogWorkerClient('games', 'engine', 'test');
    expect(background.snapshot()).toMatchObject({
      resources: [],
      indexing: true,
    });
    expect(Worker).toHaveBeenCalledTimes(1);
    worker.emit('message', {
      snapshot: {
        enabled: true,
        resources: [
          { type: 'motion', name: 'new.motionbin', config: '3d/motion/new.motionbin' },
        ],
        issues: [],
        revision: 1,
        indexing: false,
      },
    });
    expect(background.snapshot().resources[0].name).toBe('new.motionbin');
    expect(Worker).toHaveBeenCalledTimes(1);
    await background.close();
  });

  it('posts notifications without waiting for discovery to complete', async () => {
    const background = new GltfCatalogWorkerClient('games', 'engine', 'test');
    background.notify('games/test/game/3d/motion/new.motionbin');
    expect(
      worker.postMessage.mock.calls.map(([message]) => message.type),
    ).toEqual(['notify']);
    worker.emit('message', {
      snapshot: {
        enabled: true,
        resources: [],
        issues: [],
        revision: 2,
        indexing: false,
      },
    });
    expect(background.snapshot()).toMatchObject({
      revision: 2,
      indexing: false,
    });
    await background.close();
  });
  it('reuses an explicit runtime refresh result instead of issuing a filesystem notification', async () => {
    const background = new GltfCatalogWorkerClient('games', 'engine', 'test');
    const runtime = { resources: [{ type: 'shader', name: 'Eye', config: '3d/runtime/deps/config.json' }], issues: [] };
    background.setRuntimes(runtime);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'runtime', runtime });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    await background.close();
  });

  it('stops observation when its project closes', async () => {
    const background = new GltfCatalogWorkerClient('games', 'engine', 'test');
    background.start();
    await background.close();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    background.start();
    expect(Worker).toHaveBeenCalledTimes(1);
  });

  it('keeps snapshots readable after a worker error', async () => {
    const report = jest.fn();
    const background = new GltfCatalogWorkerClient(
      'games',
      'engine',
      'test',
      report,
    );
    background.start();
    worker.emit('error', new Error('failed'));
    expect(background.snapshot()).toMatchObject({
      indexing: false,
      error: 'failed',
    });
    expect(report).toHaveBeenCalledTimes(1);
    await background.close();
  });

  it('reports recoverable watch warnings without poisoning snapshots', async () => {
    const report = jest.fn();
    const background = new GltfCatalogWorkerClient(
      'games',
      'engine',
      'test',
      report,
    );
    background.start();
    worker.emit('message', { type: 'warning', error: 'temporarily locked' });
    expect(background.snapshot().error).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    await background.close();
  });

  it('forwards background read progress to the application logger', async () => {
    const progress = jest.fn();
    const background = new GltfCatalogWorkerClient('games', 'engine', 'test', () => {}, progress);
    background.start();
    worker.emit('message', { type: 'progress', message: 'glTF 动作说明读取: 12/2000, 等待 first.motionbin (打开文件)' });
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('打开文件'));
    await background.close();
  });

  it('reports failed notification delivery through its snapshot', async () => {
    const report = jest.fn();
    const background = new GltfCatalogWorkerClient(
      'games',
      'engine',
      'test',
      report,
    );
    background.start();
    worker.postMessage.mockImplementation(() => {
      throw new Error('delivery failed');
    });
    background.notify('games/test/game/3d/motion/new.motionbin');
    expect(background.snapshot()).toMatchObject({
      indexing: false,
      error: 'delivery failed',
    });
    await background.close();
  });

  it('does not repeatedly start a worker whose startup failed', async () => {
    (Worker as unknown as jest.Mock).mockImplementation(() => {
      throw new Error('startup failed');
    });
    const report = jest.fn();
    const background = new GltfCatalogWorkerClient(
      'games',
      'engine',
      'test',
      report,
    );
    expect(background.snapshot().error).toBe('startup failed');
    background.snapshot();
    expect(Worker).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    await background.close();
  });

  it('reports runtime update delivery failures without throwing into export or model selection', async () => {
    const report = jest.fn();
    const background = new GltfCatalogWorkerClient('games', 'engine', 'test', report);
    background.start();
    worker.postMessage.mockImplementation(() => { throw new Error('delivery failed'); });
    expect(() => background.setRuntimes({ resources: [], issues: [] })).not.toThrow();
    expect(background.snapshot().error).toBe('delivery failed');
    background.setRuntimes({ resources: [], issues: [] });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    await background.close();
  });

  it('publishes bootstrap state with a new revision before scanning finishes', async () => {
    const background = new GltfCatalogWorkerClient('games', 'engine', 'test');
    const initial = background.snapshot();
    expect(initial.revision).toBe(-1);
    worker.emit('message', {
      snapshot: {
        enabled: true,
        resources: [
          { type: 'shader', name: 'runtime', config: '3d/runtime/deps/config.json' },
        ],
        issues: [],
        revision: 0,
        indexing: true,
      },
    });
    expect(background.snapshot().revision).not.toBe(initial.revision);
    expect(background.snapshot()).toMatchObject({
      indexing: true,
      resources: [{ name: 'runtime' }],
    });
    await background.close();
  });
});
