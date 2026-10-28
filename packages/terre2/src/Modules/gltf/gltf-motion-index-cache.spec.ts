import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { MotionIndexCache } from './gltf-motion-index-cache';
import type { CatalogInventory } from './gltf-resource-types';

describe('persistent motion metadata', () => {
  let root: string;
  const inventory = (root: string): CatalogInventory => ({
    files: new Set([join(root, 'nested/idle.motionbin')]),
    cache: new Map([[join(root, 'nested/idle.motionbin'), { description: '待机', motionGroup: 'custom', tracks: [1, 2] }]]),
  });
  beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'terre-motion-cache-')); });
  afterEach(async () => {
    jest.restoreAllMocks(); jest.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('rebuilds damaged caches and stores only relative paths and selectable metadata', async () => {
    await fs.writeFile(join(root, '.motion-index.json'), '{broken');
    const warn = jest.fn(), state = inventory(root);
    const cache = new MotionIndexCache(root, warn);
    await cache.load(state);
    expect(warn).toHaveBeenCalledTimes(1);
    cache.schedule(state); await cache.flush();
    expect(JSON.parse(await fs.readFile(join(root, '.motion-index.json'), 'utf8'))).toEqual({
      files: { 'nested/idle.motionbin': { description: '待机', motionGroup: 'custom' } },
    });
    const writes = jest.spyOn(fs, 'writeFile');
    await cache.flush();
    expect(writes).not.toHaveBeenCalled();
  });
  it('does not create a motion directory for an empty parameter-only project', async () => {
    const path = join(root, 'motion'), state: CatalogInventory = { files: new Set() };
    const cache = new MotionIndexCache(path, jest.fn());
    await cache.load(state); cache.schedule(state); await cache.flush();
    await expect(fs.access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('coalesces short bursts and saves during sustained indexing', () => {
    jest.useFakeTimers();
    const cache = new MotionIndexCache(root, jest.fn()), state = inventory(root);
    const flush = jest.spyOn(cache, 'flush').mockResolvedValue(undefined);
    cache.schedule(state);
    jest.advanceTimersByTime(1900);
    expect(flush).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
    jest.clearAllTimers(); flush.mockClear();
    const sustained = new MotionIndexCache(root, jest.fn());
    const save = jest.spyOn(sustained, 'flush').mockResolvedValue(undefined);
    for (let i = 0; i < 10; i++) {
      sustained.schedule(state); jest.advanceTimersByTime(1000);
    }
    expect(save).toHaveBeenCalledTimes(1);
    jest.clearAllTimers();
  });
  it('keeps the last complete cache if replacement fails and retries on the next save', async () => {
    const warn = jest.fn(), state = inventory(root), cache = new MotionIndexCache(root, warn);
    await cache.load(state); cache.schedule(state); await cache.flush();
    const file = join(root, '.motion-index.json'), previous = await fs.readFile(file, 'utf8');
    state.cache.set(join(root, 'nested/idle.motionbin'), { description: '更新' });
    const replace = jest.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }));
    await cache.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(file, 'utf8')).toBe(previous);
    expect(await fs.readdir(root)).toEqual(['.motion-index.json']);
    replace.mockRestore(); await cache.flush();
    expect(JSON.parse(await fs.readFile(file, 'utf8')).files['nested/idle.motionbin']).toEqual({ description: '更新' });
  });
  it('ignores invalid cache entries without accepting paths outside the motion tree', async () => {
    await fs.writeFile(join(root, '.motion-index.json'), JSON.stringify({ files: {
      '../outside.motionbin': { description: 'outside' },
      'bad.motionbin': { description: 42 },
      'nested/idle.motionbin': { motionGroup: 'any.user.group' },
    } }));
    const state: CatalogInventory = { files: new Set() };
    await new MotionIndexCache(root, jest.fn()).load(state);
    expect([...state.cache]).toEqual([[join(root, 'nested/idle.motionbin'), { motionGroup: 'any.user.group' }]]);
  });
});
