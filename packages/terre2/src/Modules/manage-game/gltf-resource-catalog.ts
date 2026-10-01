import * as fs from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';

const resourceTypes = new Set([
  'model',
  'motion',
  'shader',
  'behavior',
  'garupa-motion',
  'garupa-expression',
  'garupa-expression-adapter',
]);

export interface GltfCatalogEntry {
  type: string;
  name: string;
  config: string;
  dependencies?: { type: string; name: string }[];
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function jsonFile(path: string) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

interface FileMetadata<T> {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  value: T;
}
interface ScanCache {
  configs: Map<string, FileMetadata<any>>;
  shaders: Map<string, FileMetadata<string[]>>;
}
// Retain only discovery metadata, not expression tables or GLB JSON payloads.
const scanCaches = new Map<string, ScanCache>();
function cacheFor(gameRoot: string) {
  let cache = scanCaches.get(gameRoot);
  scanCaches.delete(gameRoot);
  if (!cache) cache = { configs: new Map(), shaders: new Map() };
  scanCaches.set(gameRoot, cache);
  if (scanCaches.size > 4) scanCaches.delete(scanCaches.keys().next().value);
  return cache;
}

async function readMetadata<T>(
  path: string,
  cache: Map<string, FileMetadata<T>>,
  read: () => Promise<T>,
) {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (error) {
    cache.delete(path);
    throw error;
  }
  const previous = cache.get(path);
  if (
    previous &&
    previous.size === stat.size &&
    previous.mtimeMs === stat.mtimeMs &&
    previous.ctimeMs === stat.ctimeMs
  ) {
    return previous.value;
  }
  try {
    const value = await read();
    cache.set(path, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      value,
    });
    if (cache.size > 10000) cache.delete(cache.keys().next().value);
    return value;
  } catch (error) {
    cache.delete(path);
    throw error;
  }
}

function discoveryFields(manifest: any) {
  if (!Array.isArray(manifest?.components)) return {};
  return {
    components: manifest.components.map((component) => {
      if (!component || typeof component !== 'object') return null;
      const result: any = {};
      for (const field of [
        'type',
        'name',
        'namespace',
        'role',
        'model',
        'motionGroup',
        'defaultMotion',
      ]) {
        if (typeof component[field] === 'string')
          result[field] = component[field];
      }
      if (Array.isArray(component.behaviors))
        result.behaviors = component.behaviors
          .filter((behavior) => typeof behavior?.name === 'string')
          .map(({ name }) => ({ name }));
      return result;
    }),
  };
}

function pruneMetadata<T>(
  cache: Map<string, FileMetadata<T>>,
  present: Set<string>,
) {
  for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);
}

// Bound open files and filesystem work without serializing independent packages.
async function mapConcurrent<T, R>(
  items: T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

/** Read only the GLB JSON chunk, never its mesh or texture payload. */
async function materialShaders(path: string): Promise<string[]> {
  const handle = await fs.open(path, 'r');
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, 20, 0);
    if (
      bytesRead !== 20 ||
      header.readUInt32LE(0) !== 0x46546c67 ||
      header.readUInt32LE(16) !== 0x4e4f534a
    )
      throw new Error('Invalid GLB JSON chunk');
    const length = header.readUInt32LE(12);
    if (length > (await handle.stat()).size - 20)
      throw new Error('Truncated GLB JSON chunk');
    const chunk = Buffer.alloc(length);
    const read = await handle.read(chunk, 0, length, 20);
    if (read.bytesRead !== length) throw new Error('Truncated GLB JSON chunk');
    const json = JSON.parse(chunk.toString('utf8'));
    return [
      ...new Set<string>(
        (json.materials ?? [])
          .map((m) => m.extras?.shader)
          .filter((name) => typeof name === 'string' && name.length),
      ),
    ];
  } finally {
    await handle.close();
  }
}

const pending = new Map<string, { operation: Promise<any>; rerun: boolean }>();

/** Catalog paths are relative URLs rooted at game/gltf-resources.json. */
export async function generateGltfResourceCatalog(
  gameRoot: string,
  changed = false,
  defaultEngineRoot?: string,
) {
  gameRoot = resolve(gameRoot);
  const previous = pending.get(gameRoot);
  if (previous) {
    if (changed) previous.rerun = true;
    return previous.operation;
  }
  const state = { operation: null as Promise<any>, rerun: false };
  state.operation = (async () => {
    let result;
    do {
      state.rerun = false;
      result = await scan(gameRoot, defaultEngineRoot);
    } while (state.rerun);
    return result;
  })();
  pending.set(gameRoot, state);
  try {
    return await state.operation;
  } finally {
    if (pending.get(gameRoot) === state) pending.delete(gameRoot);
  }
}

async function scan(gameRoot: string, defaultEngineRoot?: string) {
  let engine;
  let customEngine = true;
  try {
    await fs.access(join(gameRoot, 'index.html'));
  } catch {
    customEngine = false;
  }
  const engineRoot =
    customEngine || !defaultEngineRoot ? gameRoot : defaultEngineRoot;
  try {
    engine = await jsonFile(join(engineRoot, 'webgal-engine.json'));
  } catch {
    return { enabled: false, resources: [], issues: [] };
  }
  if (engine?.id !== 'webgal-lovelive.lovelive')
    return { enabled: false, resources: [], issues: [] };
  const cache = cacheFor(resolve(gameRoot));
  const figureRoot = join(gameRoot, 'game', 'figure');
  const catalogPath = join(gameRoot, 'game', 'gltf-resources.json');
  const resources: GltfCatalogEntry[] = [];
  const definitions: {
    entry: GltfCatalogEntry;
    component: any;
    path: string;
  }[] = [];
  const issues: string[] = [];
  const identities = new Set<string>();
  const configPaths: string[] = [];
  let directories = [figureRoot];
  while (directories.length) {
    const children = await mapConcurrent(directories, async (directory) => {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const childDirectories: string[] = [];
      for (const file of entries) {
        const path = join(directory, file.name);
        // Do not follow junctions or symlinks outside the user's figure tree.
        if (file.isDirectory()) {
          childDirectories.push(path);
          continue;
        }
        if (!file.isFile() || file.name !== 'config.json') continue;
        configPaths.push(path);
      }
      return childDirectories;
    });
    directories = children.flat();
  }
  configPaths.sort((a, b) => a.localeCompare(b));
  const manifests = await mapConcurrent(configPaths, async (path) => {
    try {
      return {
        path,
        manifest: await readMetadata(path, cache.configs, async () =>
          discoveryFields(await jsonFile(path)),
        ),
      };
    } catch (error) {
      return { path, error };
    }
  });
  for (const { path, manifest, error } of manifests) {
    if (error) {
      issues.push(`${relative(figureRoot, path)}: ${error.message}`);
      continue;
    }
    if (!Array.isArray(manifest?.components)) continue;
    const components = manifest.components.filter(
      (component) => component && typeof component === 'object',
    );
    if (components.length !== manifest.components.length)
      issues.push(`${relative(figureRoot, path)}: invalid component`);
    const models = components.filter((component) => component.type === 'model' && component.role === 'integrated');
    if (models.length > 1)
      issues.push(
        `${relative(
          figureRoot,
          path,
        )}: one integrated model per selectable package required`,
      );
    for (const component of components) {
      if (
        !resourceTypes.has(component.type) ||
        typeof component.name !== 'string' ||
        !component.name
      )
        continue;
      if (
        component.type === 'behavior' &&
        (typeof component.namespace !== 'string' || !component.namespace)
      ) {
        issues.push(
          `${relative(figureRoot, path)}: behavior namespace missing`,
        );
        continue;
      }
      if (
        component.type === 'model' &&
        (component.role !== 'integrated' || models.length !== 1)
      )
        continue;
      const name =
        component.type === 'behavior'
          ? `${component.namespace}.${component.name}`
          : component.name;
      const identity = `${component.type}:${name}`;
      if (identities.has(identity))
        throw new Error(`Duplicate glTF resource ${identity}`);
      identities.add(identity);
      const config = relative(dirname(catalogPath), path)
        .split(sep)
        .map(encodeURIComponent)
        .join('/');
      const entry = { type: component.type, name, config };
      resources.push(entry);
      definitions.push({ entry, component, path });
    }
  }
  const adapters = definitions.filter(
    (definition) => definition.entry.type === 'garupa-expression-adapter',
  );
  const presentModels = new Set<string>();
  const modelIssues = await mapConcurrent(
    definitions.filter((definition) => definition.entry.type === 'model'),
    async ({ entry, component, path }) => {
      const localIssues: string[] = [];
      const dependencies: { type: string; name: string }[] = [];
      for (const behavior of Array.isArray(component.behaviors)
        ? component.behaviors
        : []) {
        if (typeof behavior?.name === 'string')
          dependencies.push({ type: 'behavior', name: behavior.name });
      }
      if (typeof component.defaultMotion === 'string')
        dependencies.push({
          type:
            identities.has(`garupa-motion:${component.defaultMotion}`) &&
            !identities.has(`motion:${component.defaultMotion}`)
              ? 'garupa-motion'
              : 'motion',
          name: component.defaultMotion,
        });
      for (const adapter of adapters.filter(
        (definition) =>
          definition.component.motionGroup === component.motionGroup,
      )) {
        dependencies.push({
          type: adapter.entry.type,
          name: adapter.entry.name,
        });
      }
      if (typeof component.model === 'string') {
        const modelPath = resolve(dirname(path), component.model);
        presentModels.add(modelPath);
        try {
          if (
            !inside(figureRoot, modelPath) ||
            !inside(figureRoot, await fs.realpath(modelPath))
          )
            throw new Error('Model outside figure directory');
          for (const name of await readMetadata(modelPath, cache.shaders, () =>
            materialShaders(modelPath),
          ))
            dependencies.push({ type: 'shader', name });
        } catch (error) {
          localIssues.push(
            `${entry.name}: shader hints unavailable (${error.message})`,
          );
        }
      }
      if (dependencies.length)
        entry.dependencies = dependencies.filter(
          (item, i, all) =>
            all.findIndex(
              (other) => other.type === item.type && other.name === item.name,
            ) === i,
        );
      return localIssues;
    },
  );
  issues.push(...modelIssues.flat());
  pruneMetadata(cache.configs, new Set(configPaths));
  pruneMetadata(cache.shaders, presentModels);
  resources.sort((a, b) =>
    `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`),
  );
  const content = `${JSON.stringify({
    说明: '本文件为WebGAL Terre LoveLive自动生成，请勿删除或修改，否则可能造成glTF模型与动作无法加载。若您不使用Terre进行编辑，在figure目录中增加glTF模型或动作后，需要手动编辑此文件，将其加入此列表。',
    description: 'This file is automatically generated by WebGAL Terre LoveLive. Do not delete or modify it, as this may prevent glTF models and motions from loading. If you do not use Terre for editing, you must manually edit this file to add any glTF models or motions you add to the figure directory to this list.',
    resources,
  }, null, 2)}\n`;
  let existing;
  try {
    existing = await fs.readFile(catalogPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing !== content) {
    await fs.mkdir(dirname(catalogPath), { recursive: true });
    const temporary = `${catalogPath}.tmp`;
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, catalogPath);
  }
  return { enabled: true, resources, issues };
}
