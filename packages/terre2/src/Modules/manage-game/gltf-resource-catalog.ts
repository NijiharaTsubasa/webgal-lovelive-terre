import * as fs from 'fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'path';

export interface GltfCatalogEntry {
  type: string;
  name: string;
  config: string;
  src?: string;
  description?: string;
  motionGroup?: string;
  fade_in?: number;
  fade_out?: number;
}
export interface CatalogInventory {
  files: Set<string>;
  cache?: Map<string, any>;
  cancelled?: boolean;
  generations?: Map<string, number>;
  runtime?: { resources: GltfCatalogEntry[]; issues: string[] };
}
export function invalidateCatalogFile(
  inventory: CatalogInventory,
  path: string,
) {
  inventory.cache?.delete(path);
  const generations = (inventory.generations ??= new Map());
  generations.set(path, (generations.get(path) ?? 0) + 1);
}
export function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
const urlPath = (root: string, path: string) =>
  relative(root, path).split(sep).map(encodeURIComponent).join('/');
const namePath = (root: string, path: string) =>
  relative(root, path).split(sep).join('/');
const jsonFile = async (path: string) =>
  JSON.parse(await fs.readFile(path, 'utf8'));
async function walk(
  root: string,
  accept: (path: string) => boolean,
): Promise<string[]> {
  const files: string[] = [],
    directories = [root];
  while (directories.length) {
    const directory = directories.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && accept(path)) files.push(path);
    }
  }
  return files.sort();
}
export async function gltfEnabled(
  gameRoot: string,
  defaultEngineRoot?: string,
) {
  let engineRoot = gameRoot;
  try {
    await fs.access(join(gameRoot, 'index.html'));
  } catch {
    engineRoot = defaultEngineRoot ?? gameRoot;
  }
  try {
    return (
      (await jsonFile(join(engineRoot, 'webgal-engine.json')))?.id ===
      'webgal-lovelive.lovelive'
    );
  } catch {
    return false;
  }
}
/** Only runtime package paths are persisted; resource discovery remains in memory. */
export async function scanGltfRuntimes(
  gameRoot: string,
  cancelled: () => boolean = () => false,
) {
  const root = join(gameRoot, 'game', '3d', 'runtime');
  const resources: GltfCatalogEntry[] = [],
    issues: string[] = [],
    packages: string[] = [];
  const identities = new Set<string>();
  for (const path of await walk(
    root,
    (path) => basename(path) === 'config.json',
  )) {
    try {
      const manifest = await jsonFile(path);
      if (!Array.isArray(manifest?.components))
        throw new Error('components 必须是数组');
      const entries: GltfCatalogEntry[] = [];
      const localIdentities = new Set<string>();
      for (const component of manifest.components) {
        if (
          !['shader', 'behavior', 'garupa-expression-adapter'].includes(
            component?.type,
          )
        )
          continue;
        if (typeof component.name !== 'string' || !component.name)
          throw new Error('运行时组件缺少 name');
        const name =
          component.type === 'behavior'
            ? `${component.namespace}.${component.name}`
            : component.name;
        if (component.type === 'behavior' && !component.namespace)
          throw new Error('Behavior 缺少 namespace');
        const identity = `${component.type}:${name}`;
        if (identities.has(identity) || localIdentities.has(identity))
          throw new Error(`重复的运行时组件: ${identity}`);
        localIdentities.add(identity);
        entries.push({
          type: component.type,
          name,
          config: urlPath(join(gameRoot, 'game'), path),
          ...(typeof component.motionGroup === 'string'
            ? { motionGroup: component.motionGroup }
            : {}),
        });
      }
      packages.push(urlPath(root, path));
      for (const identity of localIdentities) identities.add(identity);
      resources.push(...entries);
    } catch (error) {
      issues.push(`${namePath(root, path)}: ${error.message}`);
    }
  }
  try {
    await fs.access(root);
    const content = JSON.stringify({ packages }, null, 2) + '\n';
    const file = join(root, 'index.json');
    let old;
    try {
      old = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (old !== content) {
      if (cancelled()) throw new Error('glTF resource index was closed');
      const temporary = file + '.tmp';
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rename(temporary, file);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { resources, issues };
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
/** Reads the GLB JSON chunk without loading geometry or texture payloads. */
export async function modelShaderNames(gameRoot: string, model: any) {
  if (typeof model.model !== 'string') return [];
  const root = join(gameRoot, 'game/3d/figure');
  const path = resolve(
    root,
    model.path,
    ...model.model.split('/').map(decodeURIComponent),
  );
  if (!inside(root, path) || !inside(root, await fs.realpath(path)))
    throw new Error('模型文件超出 3d/figure');
  const handle = await fs.open(path, 'r');
  try {
    const prefix = Buffer.alloc(20);
    if (
      (await handle.read(prefix, 0, 20, 0)).bytesRead !== 20 ||
      prefix.readUInt32LE(0) !== 0x46546c67 ||
      prefix.readUInt32LE(16) !== 0x4e4f534a
    )
      throw new Error('Invalid GLB JSON chunk');
    const length = prefix.readUInt32LE(12);
    if (length > (await handle.stat()).size - 20)
      throw new Error('Truncated GLB JSON chunk');
    const chunk = Buffer.alloc(length);
    if ((await handle.read(chunk, 0, length, 20)).bytesRead !== length)
      throw new Error('Truncated GLB JSON chunk');
    const gltf = JSON.parse(chunk.toString('utf8'));
    return [
      ...new Set<string>(
        (gltf.materials ?? [])
          .map((item) => item.extras?.shader)
          .filter((name) => typeof name === 'string' && name),
      ),
    ];
  } finally {
    await handle.close();
  }
}
const relevant = (path: string) =>
  path.endsWith('.motionbin') ||
  path.endsWith('.mtn') ||
  path.endsWith('.exp.json') ||
  basename(path) === 'config.json';
export async function generateGltfResourceCatalog(
  gameRoot: string,
  _changed = false,
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
    issues: string[] = [],
    configs = new Map<string, any>();
  async function cached(path: string, read: () => Promise<any>) {
    if (cache.has(path)) return cache.get(path);
    const generation = inventory?.generations?.get(path) ?? 0;
    const value = await read();
    if (generation === (inventory?.generations?.get(path) ?? 0))
      cache.set(path, value);
    return value;
  }
  for (const path of files
    .filter(
      (path) => inside(parameterRoot, path) && basename(path) === 'config.json',
    )
    .sort()) {
    try {
      configs.set(path, await cached(path, () => jsonFile(path)));
    } catch (error) {
      issues.push(`${namePath(game, path)}: ${error.message}`);
    }
  }
  function configured(path: string, type: string) {
    let dir = dirname(path);
    const root = inside(parameterRoot, path) ? parameterRoot : motionRoot;
    while (inside(root, dir)) {
      const manifest = configs.get(join(dir, 'config.json'));
      const component = Array.isArray(manifest?.components)
        ? manifest.components.find(
            (item) =>
              item?.type === type &&
              typeof item.src === 'string' &&
              resolve(dir, ...item.src.split('/').map(decodeURIComponent)) ===
                path,
          )
        : undefined;
      if (component) return component;
      if (dir === root) break;
      dir = dirname(dir);
    }
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
      const config = native ? undefined : configured(path, type);
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
        entry.fade_in = config?.fade_in ?? 500;
        entry.fade_out = config?.fade_out ?? 500;
      } else {
        if (config?.fade_in !== undefined) entry.fade_in = config.fade_in;
        if (config?.fade_out !== undefined) entry.fade_out = config.fade_out;
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
export async function readGltfModel(gameRoot: string, modelPath: string) {
  const root = join(gameRoot, 'game', '3d', 'figure');
  const directory = resolve(
    root,
    modelPath.endsWith('/config.json') ? dirname(modelPath) : modelPath,
  );
  if (!inside(root, directory) || !inside(root, await fs.realpath(directory)))
    throw new Error('模型路径超出 3d/figure');
  const path = join(directory, 'config.json'),
    manifest = await jsonFile(path);
  if (!Array.isArray(manifest?.components))
    throw new Error('所选文件不是有效的 glTF 3D模型');
  const models = manifest.components.filter(
    (component) =>
      component?.type === 'model' && component.role === 'integrated',
  );
  if (!models.length)
    throw new Error(
      `所选文件不是有效的 glTF 3D模型（当前文件种类:${manifest.components
        .map((component) => component?.type)
        .join(', ')}）`,
    );
  if (models.length > 1) throw new Error('暂不支持一个配置包含多个glTF 3D模型');
  return {
    ...models[0],
    config: urlPath(join(gameRoot, 'game'), path),
    path: namePath(root, directory),
  };
}
export async function browseGltfModels(gameRoot: string, directory: string) {
  const root = join(gameRoot, 'game', '3d', 'figure'),
    path = resolve(root, directory);
  if (!inside(root, path)) throw new Error('模型路径超出 3d/figure');
  let entries;
  try {
    if (!inside(root, await fs.realpath(path)))
      throw new Error('模型路径超出 3d/figure');
    entries = await fs.readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { models: [], issues: [] };
    throw error;
  }
  const models: any[] = [],
    issues: string[] = [];
  const candidates = [
    directory,
    ...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name)),
  ];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, candidates.length) }, async () => {
      while (next < candidates.length) {
        const candidate = candidates[next++];
        try {
          models.push(await readGltfModel(gameRoot, candidate));
        } catch (error) {
          if (error.code !== 'ENOENT')
            issues.push(`${candidate}: ${error.message}`);
        }
      }
    }),
  );
  return {
    models: models.sort((a, b) => a.path.localeCompare(b.path)),
    issues,
  };
}
