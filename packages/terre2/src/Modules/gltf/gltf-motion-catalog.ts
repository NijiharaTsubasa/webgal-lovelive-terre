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
async function motionHeader(path: string, stage: (value: string) => void) {
  stage('打开文件');
  const handle = await fs.open(path, 'r');
  try {
    stage('读取前缀');
    const prefix = Buffer.alloc(12);
    const read = await handle.read(prefix, 0, prefix.length, 0);
    if (
      read.bytesRead !== 12 ||
      !prefix.subarray(0, 8).equals(Buffer.from([77, 79, 84, 73, 79, 78, 0, 0]))
    )
      throw new Error('Invalid binary motion prefix');
    const length = prefix.readUInt32LE(8);
    stage('读取文件大小');
    if (length > (await handle.stat()).size - 12)
      throw new Error('Truncated binary motion header');
    const header = Buffer.alloc(length);
    stage('读取 JSON 头部');
    if ((await handle.read(header, 0, length, 12)).bytesRead !== length)
      throw new Error('Truncated binary motion header');
    stage('解析 JSON 头部');
    return JSON.parse(header.toString('utf8'));
  } finally {
    stage('关闭文件');
    await handle.close();
  }
}
const relevant = (path: string) =>
  path.endsWith('.motionbin') ||
  path.endsWith('.mtn') ||
  path.endsWith('.exp.json');
export interface MotionCatalogResult {
  enabled: boolean;
  resources: GltfCatalogEntry[];
  issues: string[];
}
export async function readGltfMotionCatalog(
  gameRoot: string,
  defaultEngineRoot?: string,
  inventory?: CatalogInventory,
  onProgress?: (result: MotionCatalogResult) => void,
  reportProgress?: (message: string) => void,
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
  const headers: { path: string; entry: GltfCatalogEntry }[] = [];
  const applyHeader = (entry: GltfCatalogEntry, header: any) => {
    if (typeof header?.description === 'string' && header.description)
      entry.description = header.description;
    if (typeof header?.motionGroup === 'string')
      entry.motionGroup = header.motionGroup;
  };
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
      if (cache.has(path)) applyHeader(entry, cache.get(path));
      else headers.push({ path, entry });
    } else if (type === 'garupa-motion') {
      entry.fade_in = 500;
      entry.fade_out = 500;
    }
    resources.push(entry);
  }
  const runtime = inventory
    ? (inventory.runtime ??= await scanGltfRuntimes(gameRoot, () =>
        Boolean(inventory.cancelled),
      ))
    : await scanGltfRuntimes(gameRoot);
  if (inventory?.cancelled) throw new Error('glTF resource index was closed');
  const snapshot = (): MotionCatalogResult => ({
    enabled: true,
    resources: [
      ...resources.map((entry) => ({ ...entry })),
      ...runtime.resources,
    ],
    issues: [...issues, ...runtime.issues],
  });
  // Paths are sufficient to select/play a motion; descriptions are enrichment.
  onProgress?.(snapshot());
  let next = 0,
    completed = 0,
    lastPublished = Date.now();
  let publishTimer: ReturnType<typeof setTimeout>;
  const publish = () => {
    publishTimer = undefined;
    lastPublished = Date.now();
    onProgress?.(snapshot());
  };
  const active = new Map<string, string>();
  const timer =
    reportProgress && headers.length
      ? setInterval(() => {
          reportProgress(
            `glTF 动作说明读取: ${completed}/${headers.length}, 等待 ${[
              ...active,
            ]
              .map(([path, stage]) => `${namePath(game, path)} (${stage})`)
              .join('; ')}`,
          );
        }, 10000)
      : undefined;
  try {
    await Promise.all(
      Array.from({ length: Math.min(4, headers.length) }, async () => {
        while (next < headers.length) {
          if (inventory?.cancelled)
            throw new Error('glTF resource index was closed');
          const { path, entry } = headers[next++];
          const generation = inventory?.generations?.get(path) ?? 0;
          try {
            const header = await cached(path, () =>
              motionHeader(path, (stage) => active.set(path, stage)),
            );
            if (generation === (inventory?.generations?.get(path) ?? 0))
              applyHeader(entry, header);
          } catch (error) {
            issues.push(`${namePath(game, path)}: ${error.message}`);
          } finally {
            active.delete(path);
            completed++;
          }
          if (inventory?.cancelled)
            throw new Error('glTF resource index was closed');
          if (onProgress) {
            if (Date.now() - lastPublished >= 250) {
              if (publishTimer) clearTimeout(publishTimer);
              publish();
            } else if (!publishTimer) {
              publishTimer = setTimeout(
                publish,
                250 - (Date.now() - lastPublished),
              );
            }
          }
        }
      }),
    );
  } finally {
    if (timer) clearInterval(timer);
    if (publishTimer) clearTimeout(publishTimer);
  }
  return snapshot();
}
