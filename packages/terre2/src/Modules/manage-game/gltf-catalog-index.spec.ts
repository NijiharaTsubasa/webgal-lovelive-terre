import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { GltfCatalogIndex } from './gltf-catalog-index';
import * as catalog from './gltf-resource-catalog';

describe('watched glTF catalog', () => {
  jest.setTimeout(15000);
  let root: string;
  let index: GltfCatalogIndex;
  const game = 'demo';
  const errors: Error[] = [];
  async function put(path: string, value: unknown) {
    const file = join(root, game, path);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await fs.writeFile(
      file,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
    return file;
  }
  async function until(check: (result: any) => boolean) {
    const deadline = Date.now() + 10000;
    let last;
    while (Date.now() < deadline) {
      try {
        const result = await index.get(game);
        last = result;
        if (check(result)) return result;
      } catch {
        /* A partially written config may temporarily be invalid. */
      }
      await new Promise((done) => setTimeout(done, 40));
    }
    throw new Error(
      `Watcher did not converge: ${JSON.stringify(last)}; ${errors
        .map((error) => error.message)
        .join('; ')}`,
    );
  }
  beforeEach(async () => {
    errors.length = 0;
    root = await fs.mkdtemp(join(tmpdir(), 'terre-watch-'));
    await put('index.html', '');
    await put('webgal-engine.json', { id: 'webgal-lovelive.lovelive' });
    await put('game/figure/parameters/config.json', { components: [] });
    index = new GltfCatalogIndex(root, join(root, 'template'), (error) =>
      errors.push(error),
    );
    await index.start();
  });
  afterEach(async () => {
    await index.close();
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads an unchanged list from memory without filesystem work', async () => {
    const before = await index.get(game);
    const read = jest.spyOn(fs, 'readFile');
    const stat = jest.spyOn(fs, 'stat');
    const dirs = jest.spyOn(fs, 'readdir');
    for (let i = 0; i < 20; i++)
      expect((await index.get(game)).revision).toBe(before.revision);
    expect(read).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(dirs).not.toHaveBeenCalled();
  });

  it('discovers externally copied, renamed and deleted nested motions and expressions', async () => {
    const motion = await put('game/figure/parameters/extra/new.mtn', '# test');
    const expression = await put(
      'game/figure/parameters/extra/new.exp.json',
      {},
    );
    await until((result) => result.resources.length === 2);
    await fs.rename(
      motion,
      join(root, game, 'game/figure/parameters/extra/renamed.mtn'),
    );
    await until(
      (result) =>
        result.resources.some(
          (resource) => resource.name === 'extra/renamed',
        ) &&
        !result.resources.some(
          (resource) =>
            resource.type === 'garupa-motion' && resource.name === 'extra/new',
        ),
    );
    await fs.unlink(expression);
    await fs.rm(join(root, game, 'game/figure/parameters/extra'), {
      recursive: true,
    });
    await until((result) => result.resources.length === 0);
    expect(
      JSON.parse(
        await fs.readFile(
          join(root, game, 'game/figure/parameters/config.json'),
          'utf8',
        ),
      ).components,
    ).toEqual([]);
    await put('game/figure/parameters/later.mtn', '# test');
    await until((result) =>
      result.resources.some((resource) => resource.name === 'later'),
    );
  });

  it('keeps child config ownership and updates editable fades', async () => {
    await put('game/figure/parameters/nested/config.json', { components: [] });
    await put('game/figure/parameters/nested/one.mtn', '# test');
    await until((result) =>
      result.resources.some((resource) => resource.name === 'one'),
    );
    const config = await put('game/figure/parameters/nested/config.json', {
      components: [
        {
          type: 'garupa-motion',
          name: 'one',
          src: 'one.mtn',
          fade_in: 123,
          fade_out: 456,
        },
      ],
    });
    await index.notify(config);
    expect(
      JSON.parse(await fs.readFile(config, 'utf8')).components[0].fade_in,
    ).toBe(123);
    await fs.unlink(config);
    await until((result) =>
      result.resources.some((resource) => resource.name === 'nested/one'),
    );
  });

  it('changes revision for model metadata changes without changing catalog identities', async () => {
    const config = await put('game/figure/model/config.json', {
      components: [
        {
          type: 'model',
          role: 'integrated',
          name: 'person',
          expressions: { A: {} },
        },
      ],
    });
    await index.notify(config);
    const before = await index.get(game);
    await put('game/figure/model/config.json', {
      components: [
        {
          type: 'model',
          role: 'integrated',
          name: 'person',
          expressions: { B: {} },
        },
      ],
    });
    await index.notify(config);
    const after = await index.get(game);
    expect(after.resources).toEqual(before.resources);
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it('does not reopen unchanged GLBs when parameter files change', async () => {
    const model = await put('game/figure/model/config.json', {
      components: [
        {
          type: 'model',
          role: 'integrated',
          name: 'person',
          model: 'person.glb',
        },
      ],
    });
    const json = Buffer.from(
      JSON.stringify({ materials: [{ extras: { shader: 'toon' } }] }),
    );
    const header = Buffer.alloc(20);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(json.length, 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    const glb = join(root, game, 'game/figure/model/person.glb');
    await fs.writeFile(glb, Buffer.concat([header, json]));
    await index.notify(model);
    await index.notify(glb);
    const read = jest.spyOn(fs, 'open');
    const dirs = jest.spyOn(fs, 'readdir');
    const stat = jest.spyOn(fs, 'stat');
    const motion = await put('game/figure/parameters/new.mtn', '# test');
    await index.notify(motion);
    expect(read).not.toHaveBeenCalled();
    expect(
      dirs.mock.calls.some(
        ([path]) => path === join(root, game, 'game/figure/model'),
      ),
    ).toBe(false);
    expect(
      stat.mock.calls.some(([path]) => path === model || path === glb),
    ).toBe(false);
  });

  it('reports duplicate identities and recovers after their removal', async () => {
    await put('game/figure/other/config.json', {
      components: [{ type: 'motion', name: 'duplicate' }],
    });
    await index.notify(join(root, game, 'game/figure/other/config.json'));
    const duplicate = await put('game/figure/conflict/config.json', {
      components: [{ type: 'motion', name: 'duplicate' }],
    });
    await expect(index.notify(duplicate)).rejects.toThrow('Duplicate');
    await expect(index.get(game)).rejects.toThrow('Duplicate');
    await fs.unlink(duplicate);
    await index.notify(duplicate);
    expect(
      (await index.get(game)).resources.filter(
        (resource) => resource.name === 'duplicate',
      ),
    ).toHaveLength(1);
  });

  it('coalesces bulk copies instead of rebuilding once per file', async () => {
    const generate = jest.spyOn(catalog, 'generateGltfResourceCatalog');
    await Promise.all(
      Array.from({ length: 80 }, (_, i) =>
        put(`game/figure/parameters/bulk/${i}.mtn`, '# test'),
      ),
    );
    await until((result) => result.resources.length === 80);
    expect(generate.mock.calls.length).toBeLessThan(20);
    const generated = JSON.parse(
      await fs.readFile(
        join(root, game, 'game/figure/parameters/config.json'),
        'utf8',
      ),
    );
    expect(generated.components).toHaveLength(80);
  });

  it('observes engine changes and models saved by atomic replacement', async () => {
    const config = await put('game/figure/model/config.json', {
      components: [{ type: 'model', role: 'integrated', name: 'before' }],
    });
    await until((result) =>
      result.resources.some((resource) => resource.name === 'before'),
    );
    const temporary = await put('game/figure/model/save.tmp', {
      components: [{ type: 'model', role: 'integrated', name: 'after' }],
    });
    await fs.rename(temporary, config);
    await until((result) =>
      result.resources.some((resource) => resource.name === 'after'),
    );
    await put('webgal-engine.json', { id: 'other-engine' });
    await until((result) => !result.enabled);
    await put('webgal-engine.json', { id: 'webgal-lovelive.lovelive' });
    await until(
      (result) =>
        result.enabled &&
        result.resources.some((resource) => resource.name === 'after'),
    );
  });

  it('ignores texture and scene edits and closes the watcher cleanly', async () => {
    const before = await index.get(game);
    await put('game/figure/parameters/texture.png', 'bytes');
    await put('game/scene/start.txt', 'changeFigure:none;');
    await new Promise((done) => setTimeout(done, 350));
    expect((await index.get(game)).revision).toBe(before.revision);
    await index.close();
    await expect(index.get(game)).rejects.toThrow('closed');
  });
});
