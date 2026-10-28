import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, relative, resolve, sep } from 'path';
import { inside } from './gltf-files';
import type { CatalogInventory } from './gltf-resource-types';

interface MotionMetadata {
  description?: string;
  motionGroup?: string;
}

/** Disposable metadata cache: startup reconciliation uses paths, not file attributes. */
export class MotionIndexCache {
  private readonly file: string;
  private inventory?: CatalogInventory;
  private saved?: string;
  private existed = false;
  private debounce?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly root: string, private readonly report: (error: Error) => void) {
    this.file = join(root, '.motion-index.json');
  }

  async load(inventory: CatalogInventory) {
    this.inventory = inventory;
    try {
      const text = await fs.readFile(this.file, 'utf8');
      this.existed = true;
      const value = JSON.parse(text);
      if (!value?.files || typeof value.files !== 'object' || Array.isArray(value.files))
        throw new Error('files 必须为对象');
      const cache = inventory.cache ??= new Map();
      for (const [name, metadata] of Object.entries(value.files)) {
        const path = resolve(this.root, ...name.split('/'));
        if (!inside(this.root, path) || !name.endsWith('.motionbin') || name.includes('\\')) continue;
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
        const entry = metadata as MotionMetadata;
        if ((entry.description !== undefined && typeof entry.description !== 'string') ||
            (entry.motionGroup !== undefined && typeof entry.motionGroup !== 'string')) continue;
        cache.set(path, {
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          ...(entry.motionGroup !== undefined ? { motionGroup: entry.motionGroup } : {}),
        });
      }
      this.saved = text;
    } catch (error) {
      if (error.code !== 'ENOENT') this.report(new Error(`动作索引缓存读取失败，将重新生成: ${error.message}`));
    }
  }

  schedule(inventory: CatalogInventory) {
    this.inventory = inventory;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { void this.flush(); }, 2000);
    if (!this.deadline) this.deadline = setTimeout(() => { void this.flush(); }, 10000);
  }

  flush(): Promise<void> {
    if (this.debounce) clearTimeout(this.debounce);
    if (this.deadline) clearTimeout(this.deadline);
    this.debounce = this.deadline = undefined;
    this.writing = this.writing.then(async () => {
      const inventory = this.inventory;
      if (!inventory) return;
      const files = Object.fromEntries([...inventory.files].sort().flatMap(path => {
        if (!inside(this.root, path) || !path.endsWith('.motionbin') || !inventory.cache?.has(path)) return [];
        const value = inventory.cache.get(path);
        return [[relative(this.root, path).split(sep).join('/'), {
          ...(typeof value.description === 'string' ? { description: value.description } : {}),
          ...(typeof value.motionGroup === 'string' ? { motionGroup: value.motionGroup } : {}),
        }]];
      }));
      if (!Object.keys(files).length && !this.existed) return;
      const text = JSON.stringify({ files }, null, 2) + '\n';
      if (text === this.saved) return;
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(this.root, { recursive: true });
        await fs.writeFile(temporary, text, 'utf8');
        await fs.rename(temporary, this.file);
        this.saved = text;
        this.existed = true;
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
    }).catch(error => this.report(new Error(`动作索引缓存保存失败: ${error.message}`)));
    return this.writing;
  }
}
