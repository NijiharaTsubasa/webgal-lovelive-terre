import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { browseGltfModels, readGltfModel } from './gltf-model-packages';
import { readGltfMotionCatalog } from './gltf-motion-catalog';
import { scanGltfRuntimes } from './gltf-runtime-registry';
import type { CatalogInventory } from './gltf-resource-types';

describe('fixed glTF resource directories', () => {
  let root: string;
  async function put(path: string, value: unknown) {
    const file = join(root, path);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
    return file;
  }
  it('selects model parts independently and reports ambiguous selections', async () => {
    const head = {type:'model',role:'head',name:'garupa',model:'head.glb',preview:'head-image',expressionGroups:[{type:'eye',states:[{name:'Smile'}]}]};
    const body = {type:'model',role:'body',name:'garupa',model:'body.glb',preview:'body-image',motionGroup:'garupa'};
    await put('game/3d/figure/pair/config.json',{components:[body,head]});
    const model=await readGltfModel(root,'pair');
    expect(model.parts.map(part=>part.role)).toEqual(['head','body']);
    expect(model.role).toBe('composed');
    expect(model.expressionGroups).toEqual(head.expressionGroups);
    expect(model.motionGroup).toBe('garupa');
    expect((await readGltfModel(root,'pair','head')).preview).toBe('head-image');
    expect((await readGltfModel(root,'pair','body')).preview).toBe('body-image');
    await put('game/3d/figure/no-head-preview/config.json',{components:[{...head,preview:undefined},body]});
    expect((await readGltfModel(root,'no-head-preview','head')).preview).toBeUndefined();
    expect((await readGltfModel(root,'no-head-preview')).preview).toBeUndefined();
    for (const part of [head,body]) {
      await put(`game/3d/figure/${part.role}/config.json`,{components:[part]});
      expect((await readGltfModel(root,part.role)).role).toBe(part.role);
      expect((await readGltfModel(root,part.role)).selectionParts).toHaveLength(1);
    }
    await expect(readGltfModel(root,'head','body')).rejects.toThrow('只包含头部');
    for (const parts of [[head,head,body],[head,body,body]]) {
      await put('game/3d/figure/bad/config.json',{components:parts});
      await expect(readGltfModel(root,'bad')).rejects.toThrow('多个头部或多个身体');
      await expect(readGltfModel(root,'bad','head')).rejects.toThrow('多个头部或多个身体');
    }
    const browsed=await browseGltfModels(root,'','body');
    const pair=browsed.models.find(model=>model.path==='pair');
    expect(pair.preview).toBe('body-image');
    const headOnly=browsed.models.find(model=>model.path==='head');
    expect(headOnly).toBeDefined();
    expect(headOnly.preview).toBeUndefined();
    expect(pair.parts).toBeUndefined();
    expect(pair.selectionParts).toBeUndefined();
  });
  it('combines selected components across packages and preserves their source directories', async () => {
    const head={type:'model',role:'head',name:'Head',model:'head.glb',group:'garupa',renderProfile:'meteor',preview:'head-image',expressionGroups:[{type:'eye'}]};
    const body={type:'model',role:'body',name:'Body',model:'body.glb',group:'garupa',renderProfile:'meteor',preview:'body-image',motionGroup:'garupa'};
    await put('game/3d/figure/h/config.json',{components:[head]});
    await put('game/3d/figure/b/config.json',{components:[body]});
    const combined=await readGltfModel(root,'h/config.json+b/config.json');
    expect(combined.role).toBe('composed');
    expect(combined.expressionGroups).toEqual(head.expressionGroups);
    expect(combined.motionGroup).toBe('garupa');
    expect(combined.selectionParts.map(part=>[part.role,part.path,part.config,part.preview])).toEqual([
      ['head','h','3d/figure/h/config.json','head-image'],['body','b','3d/figure/b/config.json','body-image'],
    ]);
    await expect(readGltfModel(root,'b/config.json+h/config.json')).rejects.toThrow('只包含身体');
    await expect(readGltfModel(root,'h/config.json+b/config.json+h/config.json')).rejects.toThrow('组合路径');
    await expect(readGltfModel(root,'h/config.json+../../outside/config.json')).rejects.toThrow('超出');
    for (const mismatch of [{group:'other'},{renderProfile:'other'}]) {
      await put('game/3d/figure/b/config.json',{components:[{...body,...mismatch}]});
      await expect(readGltfModel(root,'h/config.json+b/config.json')).rejects.toThrow('不兼容');
    }
    await put('game/3d/figure/i/config.json',{components:[{...body,role:'integrated'}]});
    expect((await readGltfModel(root,'i','head')).role).toBe('integrated');
    await expect(readGltfModel(root,'h/config.json+i/config.json')).rejects.toThrow('不能使用完整模型');
  });
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
  it('discovers dedicated motion roots with path names and default fades', async () => {
    await motion('game/3d/motion/llas/idle.motionbin');
    await put('game/3d/mtn_exp/anon/bye.mtn', {});
    await put('game/3d/mtn_exp/anon/bye.exp.json', {});
    for (let i = 0; i < 100; i++)
      await put(`game/figure/2d${i}/nested/config.json`, { components: [] });
    await put('game/3d/figure/model/config.json', {
      components: [{ type: 'model', role: 'integrated', name: 'model' }],
    });
    const dirs = jest.spyOn(fs, 'readdir'),
      reads = jest.spyOn(fs, 'readFile');
    const result = await readGltfMotionCatalog(root);
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
          fade_in: 500,
          fade_out: 500,
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
  });
  it('indexes runtime packages without a fixed package count and caches them during motion updates', async () => {
    for (let i = 0; i < 5; i++)
      await put(`game/3d/runtime/runtime${i}/config.json`, {
        components: [{ type: 'shader', name: `shader${i}` }],
      });
    const inventory: CatalogInventory = { files: new Set() };
    expect(
      (await readGltfMotionCatalog(root, undefined, inventory)).resources,
    ).toHaveLength(5);
    const index = JSON.parse(
      await fs.readFile(join(root, 'game/3d/runtime/index.json'), 'utf8'),
    );
    expect(index.packages).toHaveLength(5);
    const reads = jest.spyOn(fs, 'readdir');
    await readGltfMotionCatalog(root, undefined, inventory);
    expect(reads).not.toHaveBeenCalled();
  });
  it('publishes 2000 path entries before a blocked motion header finishes', async () => {
    await motion('game/3d/motion/slow.motionbin');
    const slow = join(root, 'game/3d/motion/slow.motionbin');
    const inventory: CatalogInventory = {
      files: new Set([slow]),
      cache: new Map(),
    };
    for (let i = 0; i < 1999; i++) {
      const path = join(root, `game/3d/motion/idle${i}.motionbin`);
      inventory.files.add(path);
      inventory.cache.set(path, { description: '缓存说明' });
    }
    let release: () => void, opened: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const original = fs.open;
    jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        opened();
        await gate;
        return original(...args);
      });
    const progress = jest.fn();
    const reading = readGltfMotionCatalog(root, undefined, inventory, progress);
    await began;
    try {
      expect(progress).toHaveBeenCalled();
      expect(progress.mock.calls[0][0].resources).toHaveLength(2000);
      expect(
        progress.mock.calls[0][0].resources.find(
          (entry) => entry.name === 'slow.motionbin',
        ),
      ).toBeDefined();
    } finally {
      release();
      await reading;
    }
    expect(
      (await reading).resources.find((entry) => entry.name === 'slow.motionbin')
        .description,
    ).toBe('被拖走');
  });
  it('keeps path entries when metadata fails and continues reading other motions', async () => {
    await put('game/3d/motion/broken.motionbin', 'incomplete');
    await motion('game/3d/motion/next.motionbin');
    const progress = jest.fn();
    const result = await readGltfMotionCatalog(
      root,
      undefined,
      undefined,
      progress,
    );
    expect(progress.mock.calls[0][0].resources).toHaveLength(2);
    expect(result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'broken.motionbin' }),
        expect.objectContaining({
          name: 'next.motionbin',
          description: '被拖走',
        }),
      ]),
    );
    expect(result.issues).toEqual([
      expect.stringContaining('broken.motionbin'),
    ]);
    expect(result.issues[0]).toContain('prefix');
  });
  it('publishes later descriptions while an earlier file remains blocked', async () => {
    await motion('game/3d/motion/first.motionbin');
    await motion('game/3d/motion/later.motionbin');
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fs.open;
    jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]).endsWith('first.motionbin')) await gate;
        return original(...args);
      });
    let enriched: () => void;
    const arrived = new Promise<void>((resolve) => {
      enriched = resolve;
    });
    const reading = readGltfMotionCatalog(
      root,
      undefined,
      undefined,
      (result) => {
        if (
          result.resources.some(
            (entry) => entry.name === 'later.motionbin' && entry.description,
          )
        )
          enriched();
      },
    );
    try {
      await arrived;
    } finally {
      release();
      await reading;
    }
    expect((await reading).resources).toHaveLength(2);
  });
  it('drains every outstanding header reader before reporting cancellation', async () => {
    const files = [];
    for (let i = 0; i < 4; i++) {
      const name = `game/3d/motion/cancel${i}.motionbin`;
      await motion(name); files.push(join(root, name));
    }
    const inventory: CatalogInventory = { files: new Set(files) };
    const releases: (() => void)[] = [];
    let opened: () => void;
    const allOpened = new Promise<void>(resolve => { opened = resolve; });
    const original = fs.open;
    jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      await new Promise<void>(resolve => {
        releases.push(resolve);
        if (releases.length === 4) opened();
      });
      return original(...args);
    });
    let settled = false;
    const reading = readGltfMotionCatalog(root, undefined, inventory);
    const result = reading.then(() => { settled = true; }, error => { settled = true; return error; });
    await allOpened;
    inventory.cancelled = true;
    releases[0]();
    // Let the first reader finish its real open/read/close sequence.
    await new Promise(resolve => setTimeout(resolve, 50));
    try { expect(settled).toBe(false); }
    finally { for (const release of releases) release(); }
    expect((await result).message).toContain('closed');
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
