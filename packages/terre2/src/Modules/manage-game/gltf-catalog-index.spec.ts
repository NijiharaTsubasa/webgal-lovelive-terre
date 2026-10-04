import * as fs from 'fs/promises';
import * as nativeFs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GltfCatalogIndex } from './gltf-catalog-index';

describe('dedicated motion directory watcher', () => {
  jest.setTimeout(15000);
  let root: string, index: GltfCatalogIndex;
  const game = 'demo';
  async function put(path: string, value: unknown) {
    const file = join(root, game, path);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
    return file;
  }
  async function until(check: (result: any) => boolean) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const result = await index.get(game);
      if (check(result)) return result;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error('Watcher did not converge');
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'terre-fixed-watch-'));
    await put('index.html', '');
    await put('webgal-engine.json', { id: 'webgal-lovelive.lovelive' });
    await fs.mkdir(join(root, game, 'game/3d/motion'), { recursive: true });
    await fs.mkdir(join(root, game, 'game/3d/mtn_exp'), { recursive: true });
    index = new GltfCatalogIndex(root, '', () => {}, game);
    await index.start();
  });
  afterEach(async () => {
    await index.close();
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('returns unchanged snapshots without filesystem discovery and never watches figure or runtime', async () => {
    await index.close();
    await put('game/figure/old/model.glb', {});
    await put('game/3d/figure/new/config.json', {});
    await put('game/3d/runtime/deps/config.json', { components: [] });
    const watches = jest.spyOn(nativeFs, 'watch');
    index = new GltfCatalogIndex(root, '', () => {}, game);
    await index.start();
    expect(
      watches.mock.calls.some(([path]) => /figure|runtime/.test(String(path))),
    ).toBe(false);
    const reads = jest.spyOn(fs, 'readdir');
    for (let i = 0; i < 10; i++) await index.get(game);
    expect(reads).not.toHaveBeenCalled();
  });
  it('discovers external additions, updates fades and removes deleted parameters', async () => {
    const file = await put('game/3d/mtn_exp/anon/bye.mtn', {});
    await until((result) =>
      result.resources.some((entry) => entry.name === 'anon/bye'),
    );
    await put('game/3d/mtn_exp/config.json', {
      components: [{ type: 'garupa-motion', src: 'anon/bye.mtn', fade_in: 42 }],
    });
    await until((result) =>
      result.resources.some((entry) => entry.fade_in === 42),
    );
    await fs.unlink(file);
    await until(
      (result) => !result.resources.some((entry) => entry.name === 'anon/bye'),
    );
  });
  it('indexes files present before startup when only the parameter root exists', async () => {
    await index.close();
    await fs.rmdir(join(root, game, 'game/3d/motion'));
    await put('game/3d/mtn_exp/idle.mtn', {});
    index = new GltfCatalogIndex(root, '', () => {}, game);
    await index.start();
    expect((await index.get(game)).resources).toEqual([
      expect.objectContaining({ name: 'idle' }),
    ]);
  });
  it('does not discover unopened projects or model directory notifications', async () => {
    await fs.mkdir(join(root, 'other/game/3d/mtn_exp'), { recursive: true });
    await fs.writeFile(join(root, 'other/game/3d/mtn_exp/no.mtn'), '{}');
    await index.notify(join(root, 'other/game/3d/mtn_exp/no.mtn'));
    await put('game/3d/figure/model/hidden.mtn', {});
    await index.notify(join(root, game, 'game/3d/figure'));
    expect((await index.get(game)).resources).toEqual([]);
  });
  it('recovers a truncated motionbin when the file finishes copying', async () => {
    const file = join(root, game, 'game/3d/motion/idle.motionbin');
    await fs.writeFile(file, 'MOTION');
    await until((result) =>
      result.issues.some((issue) => issue.includes('prefix')),
    );
    const header = Buffer.from('{}'),
      prefix = Buffer.alloc(12);
    prefix.write('MOTION');
    prefix.writeUInt32LE(header.length, 8);
    await fs.writeFile(file, Buffer.concat([prefix, header]));
    await until(
      (result) =>
        result.resources.some((entry) => entry.name === 'idle.motionbin') &&
        !result.issues.length,
    );
  });
});
