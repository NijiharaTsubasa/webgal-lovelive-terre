import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  browseGltfModels,
  generateGltfResourceCatalog,
  readGltfModel,
  scanGltfRuntimes,
  CatalogInventory,
} from './gltf-resource-catalog';

describe('fixed glTF resource directories', () => {
  let root: string;
  async function put(path: string, value: unknown) {
    const file = join(root, path);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
    return file;
  }
  async function motion(path: string) {
    const file = join(root, path),
      header = Buffer.from(
        JSON.stringify({
          description: '被拖走',
          motionGroup: 'llas',
          clips: [],
        }),
      );
    const prefix = Buffer.alloc(12);
    prefix.write('MOTION');
    prefix.writeUInt32LE(header.length, 8);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await fs.writeFile(file, Buffer.concat([prefix, header]));
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'terre-fixed-'));
    await put('webgal-engine.json', { id: 'webgal-lovelive.lovelive' });
    await fs.writeFile(join(root, 'index.html'), '');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('discovers only dedicated motion roots, with path names and editable fades', async () => {
    await motion('game/3d/motion/llas/idle.motionbin');
    await put('game/3d/motion/config.json', {
      components: [
        {
          type: 'motion',
          src: 'llas/idle.motionbin',
          description: 'not used',
          motionGroup: 'not used',
        },
      ],
    });
    await put('game/3d/mtn_exp/anon/bye.mtn', {});
    await put('game/3d/mtn_exp/anon/bye.exp.json', {});
    await put('game/3d/mtn_exp/config.json', {
      components: [
        {
          type: 'garupa-motion',
          name: 'ignored-name',
          src: 'anon/bye.mtn',
          fade_in: 123,
          fade_out: 456,
        },
      ],
    });
    for (let i = 0; i < 100; i++)
      await put(`game/figure/2d${i}/nested/config.json`, { components: [] });
    await put('game/3d/figure/model/config.json', {
      components: [{ type: 'model', role: 'integrated', name: 'model' }],
    });
    const dirs = jest.spyOn(fs, 'readdir'),
      reads = jest.spyOn(fs, 'readFile');
    const result = await generateGltfResourceCatalog(root);
    expect(result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'motion',
          name: 'llas/idle.motionbin',
          description: '被拖走',
          motionGroup: 'llas',
        }),
        expect.objectContaining({
          type: 'garupa-motion',
          name: 'anon/bye',
          fade_in: 123,
          fade_out: 456,
        }),
        expect.objectContaining({
          type: 'garupa-expression',
          name: 'anon/bye',
        }),
      ]),
    );
    expect(
      dirs.mock.calls.some(([path]) => String(path).includes('figure')),
    ).toBe(false);
    expect(
      reads.mock.calls.some(([path]) => String(path).includes('figure')),
    ).toBe(false);
    expect(
      reads.mock.calls.some(
        ([path]) => String(path) === join(root, 'game/3d/motion/config.json'),
      ),
    ).toBe(false);
    await expect(
      fs.access(join(root, 'game/gltf-resources.json')),
    ).rejects.toThrow();
  });
  it('indexes runtime packages without a fixed package count and caches them during motion updates', async () => {
    for (let i = 0; i < 5; i++)
      await put(`game/3d/runtime/runtime${i}/config.json`, {
        components: [{ type: 'shader', name: `shader${i}` }],
      });
    const inventory: CatalogInventory = { files: new Set() };
    expect(
      (await generateGltfResourceCatalog(root, false, undefined, inventory))
        .resources,
    ).toHaveLength(5);
    const index = JSON.parse(
      await fs.readFile(join(root, 'game/3d/runtime/index.json'), 'utf8'),
    );
    expect(index.packages).toHaveLength(5);
    const reads = jest.spyOn(fs, 'readdir');
    await generateGltfResourceCatalog(root, false, undefined, inventory);
    expect(reads).not.toHaveBeenCalled();
  });
  it('browses only current model directory and validates selected packages', async () => {
    const preview = 'data:image/webp;base64,ABC';
    await put('game/3d/figure/a/config.json', {
      components: [
        {
          type: 'model',
          role: 'integrated',
          name: 'a',
          description: '模型',
          preview,
        },
      ],
    });
    await put('game/3d/figure/collection/deep/config.json', {
      components: [{ type: 'model', role: 'integrated', name: 'deep' }],
    });
    const models = await browseGltfModels(root, '');
    expect(models.models).toEqual([
      expect.objectContaining({
        path: 'a',
        name: 'a',
        preview,
        config: '3d/figure/a/config.json',
      }),
    ]);
    await put('game/3d/figure/b/config.json', {
      components: [{ type: 'shader', name: 'shader' }],
    });
    await expect(readGltfModel(root, 'b')).rejects.toThrow(
      '当前文件种类:shader',
    );
    await put('game/3d/figure/b/config.json', {
      components: [
        { type: 'model', role: 'integrated' },
        { type: 'model', role: 'integrated' },
      ],
    });
    await expect(readGltfModel(root, 'b')).rejects.toThrow('多个glTF');
    await expect(readGltfModel(root, '../runtime')).rejects.toThrow('超出');
  });
  it('reports duplicate runtime names and excludes invalid packages from the persisted index', async () => {
    await put('game/3d/runtime/a/config.json', {
      components: [{ type: 'shader', name: 'same' }],
    });
    await put('game/3d/runtime/b/config.json', {
      components: [{ type: 'shader', name: 'same' }],
    });
    const result = await scanGltfRuntimes(root);
    expect(result.issues[0]).toContain('重复');
    expect(result.resources).toHaveLength(1);
    expect(
      JSON.parse(
        await fs.readFile(join(root, 'game/3d/runtime/index.json'), 'utf8'),
      ).packages,
    ).toEqual(['a/config.json']);
  });
});
