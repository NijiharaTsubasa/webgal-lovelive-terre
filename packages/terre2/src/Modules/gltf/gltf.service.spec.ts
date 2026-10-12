import { Test, TestingModule } from '@nestjs/testing';
import { GltfService } from './gltf.service';
import { GltfResourceIndexService } from './gltf-resource-index.service';
import { UserDataService } from '../user-data/user-data.service';
import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import * as discovery from './gltf-runtime-registry';

describe('GltfService', () => {
  let service: GltfService;
  const catalog = {
    enabled: true,
    resources: [{ type: 'motion', name: 'idle' }],
    issues: [],
    revision: 4,
    indexing: false,
  };
  const index = {
    getGltfCatalog: jest.fn(),
    gltfCatalogSession: jest.fn(),
    updateGltfRuntimes: jest.fn(),
  };
  let root: string;

  beforeEach(async () => {
    index.getGltfCatalog.mockReset().mockResolvedValue(catalog);
    index.gltfCatalogSession.mockReset().mockResolvedValue({ ok: true });
    index.updateGltfRuntimes.mockReset();
    root = await fs.mkdtemp(join(tmpdir(), 'terre-model-select-'));
    jest.spyOn(UserDataService, 'getGameRoot').mockReturnValue(root);
    jest.spyOn(UserDataService, 'getEngineTemplateRoot').mockReturnValue(root);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GltfService,
        { provide: GltfResourceIndexService, useValue: index },
      ],
    }).compile();

    service = module.get<GltfService>(GltfService);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function put(path: string, value: any) {
    const file = join(root, 'demo', path);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await fs.writeFile(
      file,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  }
  async function model(behaviors: any[] = []) {
    await put('index.html', '');
    await put('webgal-engine.json', { id: 'webgal-lovelive.lovelive' });
    await put('game/3d/figure/a/config.json', {
      components: [
        {
          type: 'model',
          role: 'integrated',
          name: 'a',
          model: 'model.glb',
          behaviors,
        },
      ],
    });
    const json = Buffer.from(
      JSON.stringify({ materials: [{ extras: { shader: 'Eye' } }] }),
    );
    const header = Buffer.alloc(20);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(json.length, 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    await fs.writeFile(
      join(root, 'demo/game/3d/figure/a/model.glb'),
      Buffer.concat([header, json]),
    );
  }

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('returns only status for an unchanged revision and a complete snapshot otherwise', async () => {
    expect(await service.updateGltfResourceCatalog('demo', 4)).toEqual({
      enabled: true,
      revision: 4,
      indexing: false,
      unchanged: true,
    });
    expect(await service.updateGltfResourceCatalog('demo', 3)).toEqual(catalog);
  });

  it('rejects malformed session project names', () => {
    for (const name of ['../demo', '', '.', '..', undefined])
      expect(() => service.gltfCatalogSession(name)).toThrow('Invalid game name');
  });

  it('holds distinct sessions for open streams and releases them on disconnect', async () => {
    jest.useFakeTimers();
    const messages: unknown[] = [];
    const first = service.gltfCatalogSession('demo').subscribe(message => messages.push(message));
    const second = service.gltfCatalogSession('demo').subscribe();
    try {
      await jest.advanceTimersByTimeAsync(180000);
      const opens = index.gltfCatalogSession.mock.calls.filter(call => call[2]);
      expect(opens).toHaveLength(2);
      expect(opens[0][1]).not.toBe(opens[1][1]);
      expect(index.gltfCatalogSession.mock.calls.filter(call => !call[2])).toHaveLength(0);
      expect(messages.length).toBeGreaterThan(1);
      first.unsubscribe();
      expect(index.gltfCatalogSession).toHaveBeenCalledWith('demo', opens[0][1], false);
      second.unsubscribe();
      expect(index.gltfCatalogSession).toHaveBeenCalledWith('demo', opens[1][1], false);
      expect(jest.getTimerCount()).toBe(0);
    } finally { first.unsubscribe(); second.unsubscribe(); jest.useRealTimers(); }
  });

  it('releases a stream closed while initialization is pending', async () => {
    let finish: (value: unknown) => void;
    index.gltfCatalogSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const subscription = service.gltfCatalogSession('demo').subscribe();
    subscription.unsubscribe();
    finish({ ok: true });
    await Promise.resolve();
    const sessionId = index.gltfCatalogSession.mock.calls[0][1];
    expect(index.gltfCatalogSession.mock.calls).toEqual([
      ['demo', sessionId, true], ['demo', sessionId, false],
    ]);
  });
  it('rescans once for a newly copied shader package and updates the worker without another scan', async () => {
    await model([{ name: 'unused.optional', required: false }]);
    await put('game/3d/runtime/index.json', { packages: [] });
    await put('game/3d/runtime/new/config.json', {
      components: [{ type: 'shader', name: 'Eye' }],
    });
    const scan = jest.spyOn(discovery, 'scanGltfRuntimes');
    expect(await service.selectGltfModel('demo', 'a')).toMatchObject({
      name: 'a',
      path: 'a',
    });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(index.updateGltfRuntimes).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        await fs.readFile(
          join(root, 'demo/game/3d/runtime/index.json'),
          'utf8',
        ),
      ).packages,
    ).toEqual(['new/config.json']);
    await service.selectGltfModel('demo', 'a');
    expect(scan).toHaveBeenCalledTimes(1);
  });
  it('reports dependencies still missing after one refresh', async () => {
    await model([{ name: 'required.face' }]);
    const scan = jest.spyOn(discovery, 'scanGltfRuntimes');
    await expect(service.selectGltfModel('demo', 'a')).rejects.toThrow(
      'behavior:required.face, shader:Eye',
    );
    expect(scan).toHaveBeenCalledTimes(1);
  });
  it('requires behavior dependencies unless required is explicitly false', async () => {
    await model([{ name: 'required.face', required: true }, { name: 'unused.face', required: false }]);
    await expect(service.selectGltfModel('demo', 'a')).rejects.toThrow('behavior:required.face, shader:Eye');
  });
  it('allows a model without a matching parameter expression adapter', async () => {
    await model();
    await put('game/3d/figure/a/config.json', {
      components: [
        {
          type: 'model',
          role: 'integrated',
          name: 'a',
          motionGroup: 'unsupported',
          model: 'model.glb',
        },
      ],
    });
    await put('game/3d/runtime/new/config.json', {
      components: [{ type: 'shader', name: 'Eye' }],
    });
    await expect(service.selectGltfModel('demo', 'a')).resolves.toMatchObject({
      name: 'a',
    });
  });
});
