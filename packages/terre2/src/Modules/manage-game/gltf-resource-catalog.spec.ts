import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateGltfResourceCatalog } from './gltf-resource-catalog';

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
        { type: 'garupa-motion', name: 'anon/angry01', src: 'angry01.mtn' },
        { type: 'garupa-expression', name: 'Sad', src: 'sad.exp.json' },
      ],
    });
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
    expect(saved.description).toContain('automatically generated by WebGAL Terre LoveLive');
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
          await fs.readFile(
            join(root, 'game/gltf-resources.json'),
            'utf8',
          ),
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
});
