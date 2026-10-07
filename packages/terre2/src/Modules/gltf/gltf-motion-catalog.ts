import * as fs from 'fs/promises';
import { join } from 'path';
import type { CatalogInventory, GltfCatalogEntry } from './gltf-resource-types';
import { inside, walk, gltfEnabled, namePath, urlPath } from './gltf-files';
import { scanGltfRuntimes } from './gltf-runtime-registry';

export function invalidateCatalogFile(
  inventory: CatalogInventory,
  path: string,
) {
  inventory.cache?.delete(path);
  const generations = (inventory.generations ??= new Map());
  generations.set(path, (generations.get(path) ?? 0) + 1);
}
async function motionHeader(path: string) {
  const handle = await fs.open(path, 'r');
  try {
    const prefix = Buffer.alloc(12);
    const read = await handle.read(prefix, 0, prefix.length, 0);
    if (
      read.bytesRead !== 12 ||
      !prefix.subarray(0, 8).equals(Buffer.from([77, 79, 84, 73, 79, 78, 0, 0]))
    )
      throw new Error('Invalid binary motion prefix');
    const length = prefix.readUInt32LE(8);
    if (length > (await handle.stat()).size - 12)
      throw new Error('Truncated binary motion header');
    const header = Buffer.alloc(length);
    if ((await handle.read(header, 0, length, 12)).bytesRead !== length)
      throw new Error('Truncated binary motion header');
    return JSON.parse(header.toString('utf8'));
  } finally {
    await handle.close();
  }
}
const relevant = (path: string) =>
  path.endsWith('.motionbin') ||
  path.endsWith('.mtn') ||
  path.endsWith('.exp.json');
export async function readGltfMotionCatalog(
  gameRoot: string,
  defaultEngineRoot?: string,
  inventory?: CatalogInventory,
) {
  if (inventory?.cancelled) throw new Error('glTF resource index was closed');
  if (!(await gltfEnabled(gameRoot, defaultEngineRoot)))
    return { enabled: false, resources: [], issues: [] };
  const game = join(gameRoot, 'game'),
    motionRoot = join(game, '3d', 'motion'),
    parameterRoot = join(game, '3d', 'mtn_exp');
  const files = inventory
    ? [...inventory.files].filter(
        (path) => inside(motionRoot, path) || inside(parameterRoot, path),
      )
    : [
        ...(await walk(motionRoot, (path) => path.endsWith('.motionbin'))),
        ...(await walk(parameterRoot, relevant)),
      ];
  const cache = inventory
    ? (inventory.cache ??= new Map())
    : new Map<string, any>();
  const resources: GltfCatalogEntry[] = [],
    issues: string[] = [];
  async function cached(path: string, read: () => Promise<any>) {
    if (cache.has(path)) return cache.get(path);
    const generation = inventory?.generations?.get(path) ?? 0;
    const value = await read();
    if (generation === (inventory?.generations?.get(path) ?? 0))
      cache.set(path, value);
    return value;
  }
  for (const path of files.sort()) {
    const native = inside(motionRoot, path) && path.endsWith('.motionbin'),
      parameter = inside(parameterRoot, path);
    const type = native
      ? 'motion'
      : parameter && path.endsWith('.mtn')
      ? 'garupa-motion'
      : parameter && path.endsWith('.exp.json')
      ? 'garupa-expression'
      : undefined;
    if (!type) continue;
    try {
      const name = native
        ? namePath(motionRoot, path)
        : namePath(parameterRoot, path).slice(
            0,
            -(type === 'garupa-motion' ? 4 : 9),
          );
      const entry: GltfCatalogEntry = {
        type,
        name,
        config: urlPath(game, path),
        src: urlPath(game, path),
      };
      if (native) {
        const header = await cached(path, () => motionHeader(path));
        const description = header?.description;
        if (typeof description === 'string' && description)
          entry.description = description;
        const motionGroup = header?.motionGroup;
        if (typeof motionGroup === 'string') entry.motionGroup = motionGroup;
      } else if (type === 'garupa-motion') {
        entry.fade_in = 500;
        entry.fade_out = 500;
      }
      resources.push(entry);
    } catch (error) {
      issues.push(`${namePath(game, path)}: ${error.message}`);
    }
  }
  const runtime = inventory
    ? (inventory.runtime ??= await scanGltfRuntimes(gameRoot, () =>
        Boolean(inventory.cancelled),
      ))
    : await scanGltfRuntimes(gameRoot);
  if (inventory?.cancelled) throw new Error('glTF resource index was closed');
  return {
    enabled: true,
    resources: [...resources, ...runtime.resources],
    issues: [...issues, ...runtime.issues],
  };
}
