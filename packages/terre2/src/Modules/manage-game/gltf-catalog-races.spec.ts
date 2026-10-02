import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CatalogInventory,
  CatalogChangedError,
  generateGltfResourceCatalog,
  invalidateCatalogFile,
} from './gltf-resource-catalog';

describe('incremental catalog concurrency', () => {
  let root: string;
  let inventory: CatalogInventory;
  async function put(path: string, value: unknown) {
    const file = join(root, path);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
    inventory.files.add(file);
    return file;
  }
  function gate() {
    let release: () => void;
    const wait = new Promise<void>((done) => {
      release = done;
    });
    return { wait, release };
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'terre-index-race-'));
    inventory = { files: new Set() };
    await put('webgal-engine.json', { id: 'webgal-lovelive.lovelive' });
    await fs.writeFile(join(root, 'index.html'), '');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not lose an invalidation arriving during an older config read', async () => {
    const config = await put('game/figure/model/config.json', {
      components: [{ type: 'model', name: 'old', role: 'integrated' }],
    });
    const entered = gate(),
      finish = gate();
    const original = fs.readFile;
    let first = true;
    jest.spyOn(fs, 'readFile').mockImplementation((async (...args: any[]) => {
      const value = await (original as any)(...args);
      if (args[0] === config && first) {
        first = false;
        entered.release();
        await finish.wait;
      }
      return value;
    }) as any);
    const operation = generateGltfResourceCatalog(
      root,
      false,
      undefined,
      inventory,
    );
    await entered.wait;
    await put('game/figure/model/config.json', {
      components: [{ type: 'model', name: 'new', role: 'integrated' }],
    });
    invalidateCatalogFile(inventory, config);
    finish.release();
    await operation;
    const next = await generateGltfResourceCatalog(
      root,
      false,
      undefined,
      inventory,
    );
    expect(next.resources.map((resource) => resource.name)).toEqual(['new']);
  });

  async function pausedModel() {
    await put('game/figure/model/config.json', {
      components: [
        {
          type: 'model',
          name: 'person',
          role: 'integrated',
          model: 'model.glb',
        },
      ],
    });
    const path = join(root, 'game/figure/model/model.glb');
    const chunk = Buffer.from(JSON.stringify({ materials: [] }));
    const header = Buffer.alloc(20);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(chunk.length, 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    await fs.writeFile(path, Buffer.concat([header, chunk]));
    inventory.files.add(path);
    const entered = gate(),
      finish = gate();
    const original = fs.open;
    let first = true;
    jest.spyOn(fs, 'open').mockImplementation((async (...args: any[]) => {
      if (args[0] === path && first) {
        first = false;
        entered.release();
        await finish.wait;
      }
      return (original as any)(...args);
    }) as any);
    return { entered, finish };
  }

  it('preserves user fades edited while an automatic config update is being prepared', async () => {
    const config = await put('game/figure/parameters/config.json', {
      components: [],
    });
    const motion = join(root, 'game/figure/parameters/one.mtn');
    await fs.writeFile(motion, '# test');
    inventory.files.add(motion);
    const { entered, finish } = await pausedModel();
    const operation = generateGltfResourceCatalog(
      root,
      false,
      undefined,
      inventory,
    );
    const rejected =
      expect(operation).rejects.toBeInstanceOf(CatalogChangedError);
    await entered.wait;
    await put('game/figure/parameters/config.json', {
      components: [
        {
          type: 'garupa-motion',
          name: 'one',
          src: 'one.mtn',
          fade_in: 999,
          fade_out: 888,
        },
      ],
    });
    invalidateCatalogFile(inventory, config);
    finish.release();
    await rejected;
    await generateGltfResourceCatalog(root, false, undefined, inventory);
    expect(
      JSON.parse(await fs.readFile(config, 'utf8')).components[0].fade_in,
    ).toBe(999);
  });

  it('does not recreate a deleted game during an in-flight index operation', async () => {
    const { entered, finish } = await pausedModel();
    const operation = generateGltfResourceCatalog(
      root,
      false,
      undefined,
      inventory,
    );
    const rejected = expect(operation).rejects.toThrow('closed');
    await entered.wait;
    inventory.cancelled = true;
    await fs.rm(root, { recursive: true, force: true });
    finish.release();
    await rejected;
    await expect(fs.access(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
