import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { CatalogInventory, generateGltfResourceCatalog } from './gltf-resource-catalog';

describe('glTF resource catalog', () => {
  let root: string;
  async function put(path: string, value: unknown) {
    const file = join(root, path);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'terre-gltf-'));
    await put('webgal-engine.json', { id: 'webgal-lovelive.lovelive' });
    await fs.writeFile(join(root, 'index.html'), '');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps model descriptions in the catalog and excludes preview from all inventory caches', async () => {
    await put('game/figure/模型 空格/config.json', { components: [
      { type: 'model', role: 'integrated', name: 'model', description: '角色说明', preview: 'data:image/webp;base64,QUJD' },
    ] });
    const inventory: CatalogInventory = { files: new Set([
      join(root, 'webgal-engine.json'), join(root, 'index.html'), join(root, 'game/figure/模型 空格/config.json'),
    ]) };
    const result = await generateGltfResourceCatalog(root, false, undefined, inventory);
    expect(result.resources[0]).toMatchObject({ description: '角色说明' });
    expect(JSON.stringify(result)).not.toContain('preview');
    for (const cache of [inventory.cache.configs, inventory.cache.models]) {
      expect(JSON.stringify([...cache.values()])).not.toContain('data:image/webp');
    }
    const catalog = await fs.readFile(join(root, 'game/gltf-resources.json'), 'utf8');
    expect(catalog).toContain('角色说明');
    expect(catalog).not.toContain('preview');
  });

  it('preserves model preview in mixed parameter config while omitting it from caches', async () => {
    const file = 'game/figure/mixed/config.json';
    const preview = 'data:image/webp;base64,QUJD';
    await put(file, { components: [
      { type: 'model', role: 'integrated', name: 'mixed', description: '模型', preview },
      { type: 'garupa-motion', name: 'idle', src: 'idle.mtn' },
    ] });
    await put('game/figure/mixed/idle.mtn', {});
    await put('game/figure/mixed/new.mtn', {});
    const inventory: CatalogInventory = { files: new Set([
      join(root, 'webgal-engine.json'), join(root, 'index.html'), join(root, file),
      join(root, 'game/figure/mixed/idle.mtn'), join(root, 'game/figure/mixed/new.mtn'),
    ]) };
    await generateGltfResourceCatalog(root, false, undefined, inventory);
    expect(JSON.parse(await fs.readFile(join(root, file), 'utf8')).components[0].preview).toBe(preview);
    for (const cache of [inventory.cache.configs, inventory.cache.models, inventory.cache.parameterPackages]) {
      expect(JSON.stringify([...cache.values()])).not.toContain(preview);
    }
  });

  it('indexes native motion descriptions and refreshes description-only edits', async () => {
    const path = 'game/figure/motions/config.json';
    const config = (description: string) => ({ components: [
      { type: 'motion', name: 'hasunosora/mot_00_02070', description, src: 'drag.motbin' },
      { type: 'motion', name: 'llas/idle', description: '', src: 'idle.motbin' },
    ] });
    await put(path, config('被拖走'));
    const first = await generateGltfResourceCatalog(root);
    expect(first.resources.find(entry => entry.name === 'hasunosora/mot_00_02070')).toMatchObject({
      description: '被拖走',
    });
    expect(first.resources.find(entry => entry.name === 'llas/idle')).not.toHaveProperty('description');
    await put(path, config('被拉走'));
    const file = join(root, path);
    const stamp = (await fs.stat(file)).mtimeMs;
    await fs.utimes(file, new Date(stamp + 1000), new Date(stamp + 1000));
    const updated = await generateGltfResourceCatalog(root);
    expect(updated.resources.find(entry => entry.name === 'hasunosora/mot_00_02070')).toMatchObject({
      description: '被拉走',
    });
  });

  it('reuses only unchanged discovery metadata and sees external edits and removal', async () => {
    const configPath = join(root, 'game/figure/model/config.json');
    const glbPath = join(root, 'game/figure/model/model.glb');
    const model = (name: string) => ({
      components: [
        { type: 'model', name, role: 'integrated', model: 'model.glb' },
      ],
    });
    async function glb(shader: string) {
      const json = Buffer.from(
        JSON.stringify({ materials: [{ extras: { shader } }] }),
      );
      const header = Buffer.alloc(20);
      header.writeUInt32LE(0x46546c67, 0);
      header.writeUInt32LE(json.length, 12);
      header.writeUInt32LE(0x4e4f534a, 16);
      await fs.writeFile(glbPath, Buffer.concat([header, json]));
    }
    await put('game/figure/model/config.json', model('cm01'));
    await glb('toon');
    const read = jest.spyOn(fs, 'readFile');
    const open = jest.spyOn(fs, 'open');
    await generateGltfResourceCatalog(root);
    await generateGltfResourceCatalog(root);
    expect(
      read.mock.calls.filter(([path]) => path === configPath),
    ).toHaveLength(1);
    expect(open.mock.calls.filter(([path]) => path === glbPath)).toHaveLength(
      1,
    );
    // Same-length external writes must not keep the cached component or shader.
    const stamp = (await fs.stat(configPath)).mtimeMs;
    await put('game/figure/model/config.json', model('cm02'));
    await glb('edge');
    await fs.utimes(configPath, new Date(stamp + 1000), new Date(stamp + 1000));
    await fs.utimes(glbPath, new Date(stamp + 1000), new Date(stamp + 1000));
    const updated = await generateGltfResourceCatalog(root);
    expect(updated.resources[0].name).toBe('cm02');
    expect(updated.resources[0].dependencies).toContainEqual({
      type: 'shader',
      name: 'edge',
    });
    expect(
      read.mock.calls.filter(([path]) => path === configPath),
    ).toHaveLength(2);
    expect(open.mock.calls.filter(([path]) => path === glbPath)).toHaveLength(
      2,
    );
    await fs.unlink(configPath);
    expect((await generateGltfResourceCatalog(root)).resources).toEqual([]);
  });

  it('discovers mixed dependency packages and shared motions, preserving relative URL paths', async () => {
    await put('game/figure/模型 空格/config.json', {
      components: [
        {
          type: 'model',
          role: 'integrated',
          name: 'character',
          model: 'model.glb',
          motionGroup: 'llas',
          defaultMotion: 'idle',
          behaviors: [{ name: 'llas.face' }],
        },
      ],
    });
    await put('game/figure/shared/config.json', {
      components: [
        { type: 'motion', name: 'idle', src: 'idle.json' },
        {
          type: 'garupa-motion',
          name: 'anon/angry01',
          src: 'anon/angry01.mtn',
        },
        { type: 'garupa-expression', name: 'Sad', src: 'Sad.exp.json' },
      ],
    });
    await put('game/figure/shared/anon/angry01.mtn', {});
    await put('game/figure/shared/Sad.exp.json', {});
    await put('game/figure/deps/config.json', {
      components: [
        { type: 'shader', name: 'toon', src: 'toon.glsl' },
        {
          type: 'behavior',
          namespace: 'llas',
          name: 'face',
          script: 'face.js',
        },
        {
          type: 'garupa-expression-adapter',
          name: 'llas',
          motionGroup: 'llas',
          script: 'face-adapter.js',
        },
      ],
    });
    const json = Buffer.from(
      JSON.stringify({ materials: [{ extras: { shader: 'toon' } }] }),
    );
    const header = Buffer.alloc(20);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(20 + json.length + 1024 * 1024, 8);
    header.writeUInt32LE(json.length, 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    await fs.writeFile(
      join(root, 'game/figure/模型 空格/model.glb'),
      Buffer.concat([header, json, Buffer.alloc(1024 * 1024)]),
    );
    const result = await generateGltfResourceCatalog(root);
    expect(result.enabled).toBe(true);
    expect(result.resources).toHaveLength(7);
    const model = result.resources.find((entry) => entry.type === 'model');
    expect(model.config).toBe(
      'figure/%E6%A8%A1%E5%9E%8B%20%E7%A9%BA%E6%A0%BC/config.json',
    );
    expect(model.dependencies).toEqual(
      expect.arrayContaining([
        { type: 'shader', name: 'toon' },
        { type: 'behavior', name: 'llas.face' },
        { type: 'motion', name: 'idle' },
        { type: 'garupa-expression-adapter', name: 'llas' },
      ]),
    );
    expect(result.issues).toEqual([]);
    const file = join(root, 'game/gltf-resources.json');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(Object.keys(saved)).toEqual(['说明', 'description', 'resources']);
    expect(saved.说明).toContain('WebGAL Terre LoveLive自动生成');
    expect(saved.description).toContain(
      'automatically generated by WebGAL Terre LoveLive',
    );
    expect(saved.resources).toEqual(result.resources);
    const before = (await fs.stat(file)).mtimeMs;
    await generateGltfResourceCatalog(root);
    expect((await fs.stat(file)).mtimeMs).toBe(before);
  });

  it.each(['open-webgal.webgal', 'webgal-mygo.mygo', undefined])(
    'does not alter another engine (%s)',
    async (id) => {
      if (id) await put('webgal-engine.json', { id });
      else await fs.unlink(join(root, 'webgal-engine.json'));
      await put('game/gltf-resources.json', {
        resources: ['handwritten'],
      });
      expect((await generateGltfResourceCatalog(root)).enabled).toBe(false);
      expect(
        JSON.parse(
          await fs.readFile(join(root, 'game/gltf-resources.json'), 'utf8'),
        ),
      ).toEqual({ resources: ['handwritten'] });
    },
  );

  it('refreshes deletions and ignores unrelated JSON and malformed optional shader hints', async () => {
    await put('game/figure/model/config.json', {
      components: [
        { type: 'model', name: 'm', role: 'integrated', model: 'missing.glb' },
      ],
    });
    await put('game/figure/live2d/config.json', { model: 'model.moc' });
    await put('game/figure/live2d/model.json', { components: [] });
    const result = await generateGltfResourceCatalog(root);
    expect(result.resources).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
    await fs.rm(join(root, 'game/figure/model'), { recursive: true });
    expect((await generateGltfResourceCatalog(root)).resources).toEqual([]);
  });

  it('rejects ambiguous names without replacing the previous usable catalog', async () => {
    await put('game/gltf-resources.json', { resources: [] });
    for (const dir of ['a', 'b'])
      await put(`game/figure/${dir}/config.json`, {
        components: [{ type: 'motion', name: 'duplicate', src: 'motion.json' }],
      });
    await expect(generateGltfResourceCatalog(root)).rejects.toThrow(
      'Duplicate glTF resource motion:duplicate',
    );
    expect(
      JSON.parse(
        await fs.readFile(join(root, 'game/gltf-resources.json'), 'utf8'),
      ),
    ).toEqual({ resources: [] });
  });

  it('uses the same engine inheritance as the logical game file server', async () => {
    const template = join(root, 'template');
    await put('template/webgal-engine.json', {
      id: 'webgal-lovelive.lovelive',
    });
    await fs.unlink(join(root, 'webgal-engine.json'));
    // A standalone custom engine must explicitly identify itself.
    expect(
      (await generateGltfResourceCatalog(root, false, template)).enabled,
    ).toBe(false);
    // Games containing only game/ inherit the active default engine.
    await fs.unlink(join(root, 'index.html'));
    expect(
      (await generateGltfResourceCatalog(root, false, template)).enabled,
    ).toBe(true);
    await put('template/webgal-engine.json', { id: 'webgal-mygo.mygo' });
    expect(
      (await generateGltfResourceCatalog(root, false, template)).enabled,
    ).toBe(false);
  });

  it('synchronizes parameter files by exact relative paths and preserves user settings', async () => {
    const config = 'game/figure/parameters/config.json';
    await put(config, {
      components: [
        { type: 'shader', name: 'custom', src: 'custom.glsl' },
        {
          type: 'garupa-motion',
          name: 'old-name',
          src: 'anon/custom/deep.mtn',
          description: 'Custom motion',
          fade_in: 125,
          fade_out: 750,
        },
        { type: 'garupa-expression', name: 'removed', src: 'missing.exp.json' },
      ],
    });
    await put('game/figure/parameters/anon/custom/deep.mtn', {});
    await put('game/figure/parameters/anon/custom/deep.exp.json', {});
    await put('game/figure/parameters/root.mtn', {});
    const first = await generateGltfResourceCatalog(root);
    expect(first.resources.map(({ type, name }) => `${type}:${name}`)).toEqual([
      'garupa-expression:anon/custom/deep',
      'garupa-motion:anon/custom/deep',
      'garupa-motion:root',
      'shader:custom',
    ]);
    const saved = JSON.parse(await fs.readFile(join(root, config), 'utf8'));
    expect(saved.components).toContainEqual({
      type: 'garupa-motion',
      name: 'anon/custom/deep',
      description: 'Custom motion',
      src: 'anon/custom/deep.mtn',
      fade_in: 125,
      fade_out: 750,
    });
    expect(saved.components).toContainEqual({
      type: 'garupa-motion',
      name: 'root',
      src: 'root.mtn',
      fade_in: 500,
      fade_out: 500,
    });
    expect(saved.components).toContainEqual({
      type: 'garupa-expression',
      name: 'anon/custom/deep',
      src: 'anon/custom/deep.exp.json',
    });
    const stamp = (await fs.stat(join(root, config))).mtimeMs;
    await generateGltfResourceCatalog(root);
    expect((await fs.stat(join(root, config))).mtimeMs).toBe(stamp);
    saved.components.find((c) => c.name === 'root').fade_in = 999;
    saved.components.find(
      (c) => c.type === 'garupa-motion' && c.name === 'anon/custom/deep',
    ).fade_in = 225;
    await put(config, saved);
    await put('game/figure/parameters/new.mtn', {});
    await fs.unlink(join(root, 'game/figure/parameters/root.mtn'));
    await generateGltfResourceCatalog(root);
    const refreshed = JSON.parse(await fs.readFile(join(root, config), 'utf8'));
    expect(refreshed.components.some((c) => c.name === 'root')).toBe(false);
    expect(
      refreshed.components.find(
        (c) => c.type === 'garupa-motion' && c.name === 'anon/custom/deep',
      ).fade_in,
    ).toBe(225);
    expect(refreshed.components.some((c) => c.name === 'new')).toBe(true);
  });

  it('keeps empty directory markers and lets nested package configs own their files', async () => {
    await put('game/figure/parameters/config.json', { components: [] });
    await put('game/figure/parameters/child/config.json', { components: [] });
    await put('game/figure/parameters/child/anon/wave.mtn', {});
    await put('game/figure/parameters/model/config.json', {
      components: [{ type: 'model', name: 'm', role: 'integrated' }],
    });
    await put('game/figure/parameters/model/ignored.mtn', {});
    await put('game/figure/native/ignored.mtn', {});
    const result = await generateGltfResourceCatalog(root);
    expect(
      result.resources.filter((entry) => entry.type === 'garupa-motion'),
    ).toEqual([
      {
        type: 'garupa-motion',
        name: 'anon/wave',
        config: 'figure/parameters/child/config.json',
      },
    ]);
    expect(
      JSON.parse(
        await fs.readFile(
          join(root, 'game/figure/parameters/config.json'),
          'utf8',
        ),
      ),
    ).toEqual({ components: [] });
    await fs.unlink(join(root, 'game/figure/parameters/child/anon/wave.mtn'));
    await generateGltfResourceCatalog(root);
    expect(
      JSON.parse(
        await fs.readFile(
          join(root, 'game/figure/parameters/child/config.json'),
          'utf8',
        ),
      ),
    ).toEqual({ components: [] });
    await put('game/figure/parameters/child/again.mtn', {});
    expect(
      (await generateGltfResourceCatalog(root)).resources.some(
        (entry) => entry.name === 'again',
      ),
    ).toBe(true);
  });

  it('checks duplicate discovered names before writing any directory config', async () => {
    await put('game/gltf-resources.json', { resources: ['previous'] });
    for (const directory of ['a', 'b']) {
      await put(`game/figure/${directory}/config.json`, { components: [] });
      await put(`game/figure/${directory}/anon/wave.mtn`, {});
    }
    await expect(generateGltfResourceCatalog(root)).rejects.toThrow(
      'Duplicate glTF resource garupa-motion:anon/wave',
    );
    for (const directory of ['a', 'b'])
      expect(
        JSON.parse(
          await fs.readFile(
            join(root, `game/figure/${directory}/config.json`),
            'utf8',
          ),
        ),
      ).toEqual({ components: [] });
    expect(
      JSON.parse(
        await fs.readFile(join(root, 'game/gltf-resources.json'), 'utf8'),
      ),
    ).toEqual({ resources: ['previous'] });
  });

  it('finishes a catalog replacement when Windows temporarily holds the destination', async () => {
    await put('game/figure/parameters/config.json', { components: [] });
    await put('game/figure/parameters/wave.mtn', {});
    const rename = fs.rename.bind(fs);
    let failed = false;
    jest.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith('gltf-resources.json') && !failed) {
        failed = true;
        throw Object.assign(new Error('Destination busy'), { code: 'EPERM' });
      }
      return rename(source, destination);
    });
    const result = await generateGltfResourceCatalog(root);
    expect(failed).toBe(true);
    expect(
      JSON.parse(
        await fs.readFile(join(root, 'game/gltf-resources.json'), 'utf8'),
      ).resources,
    ).toEqual(result.resources);
  });

  it('preserves settings with encoded source URLs and keeps the visible path as the name', async () => {
    const config = 'game/figure/parameters/config.json';
    const localPath = '角色 空格/动作%#.mtn';
    const src = localPath.split('/').map(encodeURIComponent).join('/');
    await put(config, {
      components: [
        {
          type: 'garupa-motion',
          name: 'old',
          src,
          fade_in: 175,
          fade_out: 275,
        },
      ],
    });
    await put(`game/figure/parameters/${localPath}`, {});
    const result = await generateGltfResourceCatalog(root);
    expect(result.resources[0].name).toBe(localPath.slice(0, -4));
    const saved = JSON.parse(await fs.readFile(join(root, config), 'utf8'));
    expect(saved.components[0]).toEqual({
      type: 'garupa-motion',
      name: localPath.slice(0, -4),
      src,
      fade_in: 175,
      fade_out: 275,
    });
    const url = new URL(
      saved.components[0].src,
      'http://localhost/parameters/',
    );
    expect(url.hash).toBe('');
    expect(url.search).toBe('');
    expect(url.pathname.split('/').map(decodeURIComponent).join('/')).toBe(
      `/parameters/${localPath}`,
    );
    const stamp = (await fs.stat(join(root, config))).mtimeMs;
    await generateGltfResourceCatalog(root);
    expect((await fs.stat(join(root, config))).mtimeMs).toBe(stamp);
  });
});
