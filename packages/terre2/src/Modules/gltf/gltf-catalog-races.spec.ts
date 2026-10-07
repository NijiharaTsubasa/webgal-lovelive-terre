import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CatalogInventory } from './gltf-resource-types';
import { readGltfMotionCatalog, invalidateCatalogFile } from './gltf-motion-catalog';

describe('motion metadata indexing races', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'terre-race-'));
    await fs.writeFile(join(root, 'index.html'), '');
    await fs.writeFile(
      join(root, 'webgal-engine.json'),
      JSON.stringify({ id: 'webgal-lovelive.lovelive' }),
    );
    await fs.mkdir(join(root, 'game/3d/motion'), { recursive: true });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('does not retain stale motion metadata when a change arrives during a header read', async () => {
    const motion = join(root, 'game/3d/motion/idle.motionbin');
    const contents = (description: string) => {
      const header = Buffer.from(JSON.stringify({ description }));
      const prefix = Buffer.alloc(12);
      prefix.write('MOTION');
      prefix.writeUInt32LE(header.length, 8);
      return Buffer.concat([prefix, header]);
    };
    await fs.writeFile(motion, contents('first'));
    const inventory: CatalogInventory = {
      files: new Set([motion]),
      runtime: { resources: [], issues: [] },
    };
    const original = fs.open;
    let release: () => void, entered: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    jest.spyOn(fs, 'open').mockImplementation((async (path, ...args) => {
      const handle = await original(path, ...(args as [any]));
      if (String(path) === motion && first) {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs) => {
          const value = await read(...readArgs);
          if (readArgs[3] === 12 && first) {
            first = false;
            entered();
            await gate;
          }
          return value;
        }) as any;
      }
      return handle;
    }) as any);
    const reading = readGltfMotionCatalog(
      root,
      undefined,
      inventory,
    );
    await ready;
    await fs.writeFile(motion, contents('after'));
    invalidateCatalogFile(inventory, motion);
    release();
    await reading;
    expect(
      (await readGltfMotionCatalog(root, undefined, inventory))
        .resources[0].description,
    ).toBe('after');
  });
  it('does not persist a full resource catalog and rejects cancelled inventories', async () => {
    const inventory: CatalogInventory = { files: new Set(), cancelled: true };
    await expect(
      readGltfMotionCatalog(root, undefined, inventory),
    ).rejects.toThrow('closed');
    await expect(
      fs.access(join(root, 'game/gltf-resources.json')),
    ).rejects.toThrow();
  });
});
