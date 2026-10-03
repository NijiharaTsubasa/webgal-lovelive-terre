import * as fs from 'fs/promises';
import * as nativeFs from 'fs';
import { join, resolve } from 'path';
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

  for (const startup of [false, true]) {
    it(`recovers EBUSY during ${startup ? 'startup' : 'external copying'} and continues observing edits and removal`, async () => {
      if (startup) await index.close();
      const configPath = join(root, game, 'game/figure/copied/config.json');
      const glbPath = join(root, game, 'game/figure/copied/model.glb');
      const writeGlb = async (shader: string) => {
        const json = Buffer.from(JSON.stringify({ materials: [{ extras: { shader } }] }));
        const header = Buffer.alloc(20);
        header.writeUInt32LE(0x46546c67, 0);
        header.writeUInt32LE(json.length, 12);
        header.writeUInt32LE(0x4e4f534a, 16);
        await fs.writeFile(glbPath, Buffer.concat([header, json]));
      };
      const original = nativeFs.watch;
      let locked = true;
      let attempts = 0;
      jest.spyOn(nativeFs, 'watch').mockImplementation(((path, ...args) => {
        if (resolve(String(path)) === glbPath) {
          attempts++;
          if (locked) throw Object.assign(new Error(`EBUSY: watch '${glbPath}'`), { code: 'EBUSY', path: glbPath });
        }
        return original(path, ...args);
      }) as typeof nativeFs.watch);
      await put('game/figure/copied/config.json', { components: [{ type: 'model', role: 'integrated', name: 'copied', model: 'model.glb' }] });
      await writeGlb('before');
      if (startup) {
        index = new GltfCatalogIndex(root, join(root, 'template'), error => errors.push(error));
        await index.start();
      }
      const deadline = Date.now() + 3000;
      while (!attempts && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
      expect(attempts).toBeGreaterThan(0);
      await put('game/figure/parameters/available.mtn', '# test');
      const duringCopy = await until(result => result.resources.some(resource => resource.name === 'available'));
      expect(duringCopy.resources.some(resource => resource.name === 'copied')).toBe(false);
      expect(errors.filter(error => (error as NodeJS.ErrnoException).path === glbPath)).toHaveLength(1);
      locked = false;
      await until(result => result.resources.some(resource => resource.name === 'copied'));
      const retryDeadline = Date.now() + 3000;
      while (attempts < 2 && Date.now() < retryDeadline) await new Promise(done => setTimeout(done, 20));
      expect(attempts).toBeGreaterThan(1);
      // Allow the newly registered native watcher to settle before testing events.
      await new Promise(done => setTimeout(done, 350));
      await writeGlb('after');
      await until(result => result.resources.find(resource => resource.name === 'copied')?.dependencies.some(dependency => dependency.name === 'after'));
      await fs.unlink(glbPath);
      await until(result => result.issues.some(issue => issue.includes('copied: shader hints unavailable')));
      await put('game/figure/copied/config.json', { components: [{ type: 'model', role: 'integrated', name: 'edited' }] });
      await until(result => result.resources.some(resource => resource.name === 'edited') && !result.resources.some(resource => resource.name === 'copied'));
      await fs.unlink(configPath);
      await until(result => !result.resources.some(resource => resource.name === 'edited'));
    });
  }

  it('keeps permanent watcher errors visible and stops lock retries on close', async () => {
    const watcher = (index as unknown as { watcher: { emit: (event: string, error: Error) => void } }).watcher;
    watcher.emit('error', Object.assign(new Error('watch denied'), { code: 'EACCES', path: join(root, game, 'game/figure/parameters/config.json') }));
    await expect(index.get(game)).rejects.toThrow('watch denied');
    await index.close();
    index = new GltfCatalogIndex(root, join(root, 'template'), error => errors.push(error));
    await index.start();
    const path = join(root, game, 'game/figure/locked/config.json');
    const original = nativeFs.watch;
    let attempts = 0;
    jest.spyOn(nativeFs, 'watch').mockImplementation(((file, ...args) => {
      if (resolve(String(file)) === path) {
        attempts++;
        throw Object.assign(new Error('locked'), { code: 'EBUSY', path });
      }
      return original(file, ...args);
    }) as typeof nativeFs.watch);
    await put('game/figure/locked/config.json', { components: [] });
    const deadline = Date.now() + 3000;
    while (!attempts && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
    expect(attempts).toBeGreaterThan(0);
    await index.close();
    const stopped = attempts;
    await new Promise(done => setTimeout(done, 600));
    expect(attempts).toBe(stopped);
  });

  it('handles a locked target removed before retry and observes later recreation', async () => {
    const path = await put('game/figure/parameters/removed.mtn', '# test');
    await until(result => result.resources.some(resource => resource.name === 'removed'));
    const watcher = (index as unknown as { watcher: { emit: (event: string, error: Error) => void } }).watcher;
    watcher.emit('error', Object.assign(new Error('locked'), { code: 'EBUSY', path }));
    await fs.unlink(path);
    await until(result => !result.resources.some(resource => resource.name === 'removed'));
    await new Promise(done => setTimeout(done, 350));
    await put('game/figure/parameters/removed.mtn', '# recreated');
    await until(result => result.resources.some(resource => resource.name === 'removed'));
    await fs.unlink(path);
    await until(result => !result.resources.some(resource => resource.name === 'removed'));
  });

  it('preserves ready resources without duplicates when two targets in one package recover', async () => {
    const first = await put('game/figure/parameters/first.mtn', '# first');
    const second = await put('game/figure/parameters/second.mtn', '# second');
    await until(result => result.resources.length === 2);
    const watcher = (index as unknown as { watcher: { emit: (event: string, error: Error) => void } }).watcher;
    for (const path of [first, second]) watcher.emit('error', Object.assign(new Error('locked'), { code: 'EBUSY', path }));
    const preserved = await index.get(game);
    expect(preserved.resources.map(resource => resource.name).sort()).toEqual(['first', 'second']);
    await until(result => result.resources.length === 2 && result.revision > preserved.revision);
    await put('game/figure/parameters/later.mtn', '# later');
    await until(result => result.resources.length === 3);
    expect((await index.get(game)).resources.map(resource => resource.name).sort()).toEqual(['first', 'later', 'second']);
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
