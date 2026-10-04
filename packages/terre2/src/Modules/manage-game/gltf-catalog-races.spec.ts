import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CatalogInventory,
  generateGltfResourceCatalog,
  invalidateCatalogFile,
} from './gltf-resource-catalog';

describe('motion metadata indexing races', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'terre-race-'));
    await fs.writeFile(join(root, 'index.html'), '');
    await fs.writeFile(
      join(root, 'webgal-engine.json'),
      JSON.stringify({ id: 'webgal-lovelive.lovelive' }),
    );
    await fs.mkdir(join(root, 'game/3d/mtn_exp'), { recursive: true });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('does not retain stale fade metadata when a change arrives during a config read', async () => {
    const config = join(root, 'game/3d/mtn_exp/config.json'),
      mtn = join(root, 'game/3d/mtn_exp/idle.mtn');
    const contents = (fade_in: number) =>
      JSON.stringify({
        components: [{ type: 'garupa-motion', src: 'idle.mtn', fade_in }],
      });
    await fs.writeFile(config, contents(123));
    await fs.writeFile(mtn, '{}');
    const inventory: CatalogInventory = {
      files: new Set([config, mtn]),
      runtime: { resources: [], issues: [] },
    };
    const original = fs.readFile;
    let release: () => void, entered: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    jest.spyOn(fs, 'readFile').mockImplementation((async (path, ...args) => {
      const value = await original(path, ...(args as [any]));
      if (String(path) === config && first) {
        first = false;
        entered();
        await gate;
      }
      return value;
    }) as any);
    const reading = generateGltfResourceCatalog(
      root,
      false,
      undefined,
      inventory,
    );
    await ready;
    await fs.writeFile(config, contents(456));
    invalidateCatalogFile(inventory, config);
    release();
    await reading;
    expect(
      (await generateGltfResourceCatalog(root, false, undefined, inventory))
        .resources[0].fade_in,
    ).toBe(456);
    expect(
      JSON.parse(await fs.readFile(config, 'utf8')).components[0].fade_in,
    ).toBe(456);
  });
  it('does not persist a full resource catalog and rejects cancelled inventories', async () => {
    const inventory: CatalogInventory = { files: new Set(), cancelled: true };
    await expect(
      generateGltfResourceCatalog(root, false, undefined, inventory),
    ).rejects.toThrow('closed');
    await expect(
      fs.access(join(root, 'game/gltf-resources.json')),
    ).rejects.toThrow();
  });
});
