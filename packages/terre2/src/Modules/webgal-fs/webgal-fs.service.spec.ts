import { ConsoleLogger } from '@nestjs/common';
import * as fs from 'fs/promises';
import { join, resolve } from 'path';
import AdmZip = require('adm-zip');
import { WebgalFsService } from './webgal-fs.service';
import { UserDataService } from '../user-data/user-data.service';
import { GltfCatalogWorkerClient } from '../gltf/gltf-catalog-worker-client';
import { GltfResourceIndexService } from '../gltf/gltf-resource-index.service';

// These filesystem tests never invoke the OS recycle bin.
jest.mock('trash', () => ({ __esModule: true, default: jest.fn() }));

describe('WebgalFsService', () => {
  const testRoot = join(
    process.cwd(),
    'tmp',
    'webgal-fs-service-spec',
    `run-${Date.now()}`,
  );
  let service: WebgalFsService;
  let index: GltfResourceIndexService;

  beforeEach(async () => {
    index = new GltfResourceIndexService(new ConsoleLogger());
    service = new WebgalFsService(new ConsoleLogger(), index);
    await fs.mkdir(testRoot, { recursive: true });
    jest.spyOn(UserDataService, 'getGameRoot').mockImplementation(name => name ? join(testRoot, 'games', name) : join(testRoot, 'games'));
    jest.spyOn(UserDataService, 'getEngineTemplateRoot').mockReturnValue(join(testRoot, 'template'));
  });

  afterEach(async () => {
    await index.onModuleDestroy();
    jest.restoreAllMocks();
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it('refreshes the glTF catalog after resource edits, renames and deletions', async () => {
    const games = join(testRoot, 'games');
    const game = join(games, 'demo');
    const resource = join(game, 'game', '3d', 'mtn_exp');
    await fs.mkdir(resource, { recursive: true });
    await fs.writeFile(join(game, 'index.html'), '');
    await fs.writeFile(
      join(game, 'webgal-engine.json'),
      JSON.stringify({ id: 'webgal-lovelive.lovelive' }),
    );
    jest
      .spyOn(UserDataService, 'getGameRoot')
      .mockImplementation((name) => (name ? join(games, name) : games));
    jest
      .spyOn(UserDataService, 'getEngineTemplateRoot')
      .mockReturnValue(join(testRoot, 'template'));
    const config = join(resource, 'idle.mtn');
    await index.getGltfCatalog('demo');
    await service.updateTextFile(config, '{}');
    await index.ensureGltfCatalog('demo');
    expect(
      (await index.ensureGltfCatalog('demo')).resources[0].name,
    ).toBe('idle');
    await service.renameFile(config, 'not-a-manifest.json');
    await index.ensureGltfCatalog('demo');
    expect((await index.ensureGltfCatalog('demo')).resources).toEqual(
      [],
    );
    await service.updateTextFile(config, '{}');
    await service.deleteFile(config);
    await index.ensureGltfCatalog('demo');
    expect((await index.ensureGltfCatalog('demo')).resources).toEqual(
      [],
    );
  });

  it('does not start discovery when copying resources into an unopened project', async () => {
    const games = join(testRoot, 'games');
    jest.spyOn(UserDataService, 'getGameRoot').mockReturnValue(games);
    jest.spyOn(UserDataService, 'getEngineTemplateRoot').mockReturnValue(join(testRoot, 'template'));
    const start = jest.spyOn(GltfCatalogWorkerClient.prototype, 'start').mockImplementation(() => {});
    await index.notifyFile(join(games, 'new-game/game/figure/model/config.json'));
    expect(start).not.toHaveBeenCalled();
  });

  it('allows regular Windows absolute paths in segment validation', () => {
    expect(
      WebgalFsService.hasInvalidPathSegments(
        'C:\\repo\\public\\games\\demo\\scene.txt',
        'win32',
      ),
    ).toBe(false);
  });

  it('shares initialization across simultaneous catalog readers', async () => {
    const games = join(testRoot, 'games');
    const game = join(games, 'demo');
    const config = join(game, 'game/3d/mtn_exp/idle.mtn');
    await fs.mkdir(join(config, '..'), { recursive: true });
    await fs.writeFile(join(game, 'index.html'), '');
    await fs.writeFile(
      join(game, 'webgal-engine.json'),
      JSON.stringify({ id: 'webgal-lovelive.lovelive' }),
    );
    await fs.writeFile(
      config,
      JSON.stringify({ components: [{ type: 'motion', name: 'idle' }] }),
    );
    jest
      .spyOn(UserDataService, 'getGameRoot')
      .mockImplementation((name) => (name ? join(games, name) : games));
    jest
      .spyOn(UserDataService, 'getEngineTemplateRoot')
      .mockReturnValue(join(testRoot, 'template'));
    const start = jest.spyOn(GltfCatalogWorkerClient.prototype, 'start');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => index.getGltfCatalog('demo')),
    );
    expect(results.every((result) => result.indexing)).toBe(true);
    expect((index as any).catalogIndexes.size).toBe(1);
    expect(start.mock.instances.every(instance => instance === start.mock.instances[0])).toBe(true);
    expect((await index.ensureGltfCatalog('demo')).resources).toEqual([expect.objectContaining({ name: 'idle' })]);
  });

  it('returns a snapshot without waiting for slow discovery', async () => {
    jest.spyOn(GltfCatalogWorkerClient.prototype, 'start').mockImplementation(() => {});
    const settle = jest.spyOn(GltfCatalogWorkerClient.prototype, 'settled').mockImplementation(() => new Promise(() => {}));
    const result = await index.getGltfCatalog('demo');
    expect(result).toMatchObject({ indexing: true, resources: [] });
    expect(settle).not.toHaveBeenCalled();
  });

  it('keeps an index until the last editor session leaves and reclaims expired sessions', async () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(GltfCatalogWorkerClient.prototype, 'start').mockImplementation(() => {});
      const close = jest.spyOn(GltfCatalogWorkerClient.prototype, 'close').mockResolvedValue();
      await index.gltfCatalogSession('demo', 'tab-a', true);
      await index.gltfCatalogSession('demo', 'tab-b', true);
      await index.gltfCatalogSession('demo', 'tab-a', false);
      await jest.advanceTimersByTimeAsync(10000);
      expect(close).not.toHaveBeenCalled();
      await index.gltfCatalogSession('demo', 'tab-b', false);
      await jest.advanceTimersByTimeAsync(10000);
      expect(close).toHaveBeenCalledTimes(1);
      await index.gltfCatalogSession('demo', 'lost-tab', true);
      await jest.advanceTimersByTimeAsync(45000);
      expect(close).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });

  it('suspends an open index throughout copying and restarts it only after the copy ends', async () => {
    jest.spyOn(GltfCatalogWorkerClient.prototype, 'start').mockImplementation(() => {});
    const close = jest.spyOn(GltfCatalogWorkerClient.prototype, 'close').mockResolvedValue();
    const root = join(testRoot, 'games');
    jest.spyOn(UserDataService, 'getGameRoot').mockReturnValue(root);
    await index.gltfCatalogSession('demo', 'tab', true);
    let finish: () => void;
    const copied = new Promise<void>(resolve => { finish = resolve; });
    const cp = jest.spyOn(fs, 'cp').mockImplementation(() => copied);
    const operation = service.copy(join(testRoot, 'source'), join(root, 'demo/game/3d/motion'));
    while (!cp.mock.calls.length) await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    expect((index as any).catalogIndexes.size).toBe(0);
    expect((await index.getGltfCatalog('demo')).indexing).toBe(true);
    expect((index as any).catalogIndexes.size).toBe(0);
    finish();
    await operation;
    expect((index as any).catalogIndexes.size).toBe(1);
  });

  it('does not retire the worker while a long export is waiting for initial discovery', async () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(GltfCatalogWorkerClient.prototype, 'start').mockImplementation(() => {});
      const close = jest.spyOn(GltfCatalogWorkerClient.prototype, 'close').mockResolvedValue();
      let finish: (value: any) => void;
      jest.spyOn(GltfCatalogWorkerClient.prototype, 'settled').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const exporting = index.ensureGltfCatalog('demo');
      await jest.advanceTimersByTimeAsync(60000);
      expect(close).not.toHaveBeenCalled();
      finish({ enabled: true, resources: [], issues: [], revision: 1, indexing: false });
      await exporting;
      await jest.advanceTimersByTimeAsync(10000);
      expect(close).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });
  it('does not restart motion discovery when copying model or runtime packages', async () => {
    jest.spyOn(GltfCatalogWorkerClient.prototype, 'start').mockImplementation(() => {});
    const close = jest.spyOn(GltfCatalogWorkerClient.prototype, 'close').mockResolvedValue();
    jest.spyOn(fs, 'cp').mockResolvedValue();
    await index.gltfCatalogSession('demo', 'tab', true);
    const root = UserDataService.getGameRoot();
    await service.copy(join(testRoot, 'source'), join(root, 'demo/game/3d/figure/new'));
    await service.copy(join(testRoot, 'source'), join(root, 'demo/game/3d/runtime/new'));
    expect(close).not.toHaveBeenCalled();
    expect((index as any).catalogIndexes.size).toBe(1);
  });

  it('rejects invalid marks in path segments', () => {
    expect(
      WebgalFsService.hasInvalidPathSegments(
        'C:\\repo\\public\\games\\bad|name.txt',
        'win32',
      ),
    ).toBe(true);
  });

  it('rejects traversal path segments', () => {
    expect(
      WebgalFsService.hasInvalidPathSegments(
        '/home/app/public/../secret.txt',
        'linux',
      ),
    ).toBe(true);
  });

  it('creates an empty file for valid path', async () => {
    const targetFilePath = join(testRoot, 'valid.txt');
    const ret = await service.createEmptyFile(targetFilePath);
    expect(ret).toBe('created');
    await expect(fs.stat(targetFilePath)).resolves.toBeDefined();
  });

  it('blocks creating files out of workspace', async () => {
    const outsidePath = join(
      resolve(process.cwd(), '..'),
      `webgal-fs-outside-${Date.now()}.txt`,
    );
    const ret = await service.createEmptyFile(outsidePath);
    expect(ret).toBe('path error or no right.');
  });

  it('compresses a directory into a zip file path', async () => {
    const sourceDir = join(testRoot, 'source');
    const zipPath = join(testRoot, 'source.zip');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(join(sourceDir, 'template.json'), '{}');

    await expect(service.compressedDirectory(sourceDir, zipPath)).resolves.toBe(
      true,
    );
    expect((await fs.stat(zipPath)).isFile()).toBe(true);
  });

  it('returns null when reading an invalid zip buffer', () => {
    expect(
      service.readFileInZipToBuffer(Buffer.from('not a zip'), 'template.json'),
    ).toBeNull();
  });

  it('detects zip entry paths that would escape the target directory', () => {
    const hasUnsafeZipEntryPath = (
      service as unknown as {
        hasUnsafeZipEntryPath: (entryPath: string) => boolean;
      }
    ).hasUnsafeZipEntryPath.bind(service);

    expect(hasUnsafeZipEntryPath('../outside.txt')).toBe(true);
    expect(hasUnsafeZipEntryPath('/outside.txt')).toBe(true);
    expect(hasUnsafeZipEntryPath('C:/outside.txt')).toBe(true);
    expect(hasUnsafeZipEntryPath('template/assets/main.css')).toBe(false);
  });

  it('does not extract normalized zip entries outside the target directory', async () => {
    const zip = new AdmZip();
    zip.addFile('../outside.txt', Buffer.from('blocked'));
    const outsidePath = join(testRoot, '..', 'outside.txt');
    const extractedPath = join(testRoot, 'out', 'outside.txt');

    try {
      await expect(
        service.decompressedDirectory(zip.toBuffer(), join(testRoot, 'out')),
      ).resolves.toBe(true);
      await expect(fs.stat(extractedPath)).resolves.toBeDefined();
      await expect(fs.stat(outsidePath)).rejects.toBeDefined();
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });
});
