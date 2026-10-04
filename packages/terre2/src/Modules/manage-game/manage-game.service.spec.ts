import { Test, TestingModule } from '@nestjs/testing';
import { ConsoleLogger } from '@nestjs/common';
import { ManageGameService } from './manage-game.service';
import { WebgalFsService } from '../webgal-fs/webgal-fs.service';
import { UserDataService } from '../user-data/user-data.service';
import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import * as discovery from './gltf-resource-catalog';

jest.mock('trash', () => ({ __esModule: true, default: jest.fn() }));

describe('ManageGameService', () => {
  let service: ManageGameService;
  const catalog = {
    enabled: true,
    resources: [{ type: 'motion', name: 'idle' }],
    issues: [],
    revision: 4,
    indexing: false,
  };
  const filesystem = {
    getGltfCatalog: jest.fn(),
    gltfCatalogSession: jest.fn(),
    updateGltfRuntimes: jest.fn(),
  };
  let root: string;

  beforeEach(async () => {
    filesystem.getGltfCatalog.mockReset().mockResolvedValue(catalog);
    filesystem.gltfCatalogSession.mockReset().mockResolvedValue({ ok: true });
    filesystem.updateGltfRuntimes.mockReset();
    root = await fs.mkdtemp(join(tmpdir(), 'terre-model-select-'));
    jest.spyOn(UserDataService, 'getGameRoot').mockReturnValue(root);
    jest.spyOn(UserDataService, 'getEngineTemplateRoot').mockReturnValue(root);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ManageGameService,
        {
          provide: ConsoleLogger,
          useValue: { log: jest.fn(), error: jest.fn() },
        },
        { provide: WebgalFsService, useValue: filesystem },
      ],
    }).compile();

    service = module.get<ManageGameService>(ManageGameService);
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

  it('rejects malformed sessions and forwards valid editor leases', async () => {
    await expect(
      service.gltfCatalogSession('../demo', 'tab', true),
    ).rejects.toThrow('Invalid catalog session');
    await expect(service.gltfCatalogSession('demo', '', true)).rejects.toThrow(
      'Invalid catalog session',
    );
    expect(await service.gltfCatalogSession('demo', 'tab', false)).toEqual({
      ok: true,
    });
    expect(filesystem.gltfCatalogSession).toHaveBeenCalledWith(
      'demo',
      'tab',
      false,
    );
  });
  it('rescans once for a newly copied shader package and updates the worker without another scan', async () => {
    await model([{ name: 'unused.optional', optional: true }]);
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
    expect(filesystem.updateGltfRuntimes).toHaveBeenCalledTimes(1);
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
