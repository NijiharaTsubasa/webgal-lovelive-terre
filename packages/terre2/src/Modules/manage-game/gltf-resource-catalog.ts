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
  description?: string;
  dependencies?: { type: string; name: string }[];
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function jsonFile(path: string) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

async function replaceFile(path: string, content: string) {
  const temporary = `${path}.tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temporary, path);
      return;
    } catch (error) {
      if (attempt >= 4 || !['EPERM', 'EBUSY'].includes(error.code)) throw error;
      await new Promise((done) => setTimeout(done, 25 * (attempt + 1)));
    }
  }
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
  parameterPackages?: Map<
    string,
    { manifest: any; files: string[]; components: any[] }
  >;
  models?: Map<
    string,
    {
      component: any;
      context: string;
      modelPath?: string;
      dependencies: { type: string; name: string }[];
      issues: string[];
    }
  >;
}
export interface CatalogInventory {
  files: Set<string>;
  cache?: ScanCache;
  invalidated?: Set<string>;
  cancelled?: boolean;
}

export class CatalogChangedError extends Error {}

export function invalidateCatalogFile(
  inventory: CatalogInventory,
  path: string,
) {
  inventory.cache?.configs.delete(path);
  inventory.cache?.shaders.delete(path);
  (inventory.invalidated ??= new Set()).add(path);
}
// Cache discovery fields and editable parameter configs, not GLB payloads.
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
  indexed = false,
) {
  if (indexed && cache.has(path)) return cache.get(path).value;
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
    if (!indexed && cache.size > 10000) cache.delete(cache.keys().next().value);
    return value;
  } catch (error) {
    cache.delete(path);
    throw error;
  }
}

function discoveryFields(manifest: any) {
  if (!Array.isArray(manifest?.components)) return {};
  if (parameterDirectory(manifest)) return {
    ...manifest,
    components: manifest.components.map(component => {
      if (component?.type !== 'model') return component;
      const { preview, ...metadata } = component;
      return metadata;
    }),
  };
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
      if (['motion', 'model'].includes(component.type) && typeof component.description === 'string')
        result.description = component.description;
      return result;
    }),
  };
}

const parameterTypes = new Set(['garupa-motion', 'garupa-expression']);

function parameterDirectory(manifest: any) {
  return (
    Array.isArray(manifest?.components) &&
    (manifest.components.length === 0 ||
      manifest.components.some((component) =>
        parameterTypes.has(component?.type),
      ))
  );
}

function parameterType(path: string) {
  if (path.endsWith('.exp.json')) return 'garupa-expression';
  if (path.endsWith('.mtn')) return 'garupa-motion';
  return undefined;
}

function parameterComponents(root: string, components: any[], files: string[]) {
  const retained = components.filter(
    (component) => !parameterTypes.has(component?.type),
  );
  const previous = new Map<string, any>();
  for (const component of components) {
    if (
      parameterTypes.has(component?.type) &&
      typeof component.src === 'string'
    ) {
      let source: string;
      try {
        source = component.src.split('/').map(decodeURIComponent).join('/');
      } catch {
        continue;
      }
      previous.set(`${component.type}:${resolve(root, source)}`, component);
    }
  }
  for (const file of files.sort((a, b) => a.localeCompare(b))) {
    const type = parameterType(file);
    const segments = relative(root, file).split(sep);
    const relativePath = segments.join('/');
    const src = segments.map(encodeURIComponent).join('/');
    const name = relativePath.slice(
      0,
      -(type === 'garupa-motion' ? '.mtn'.length : '.exp.json'.length),
    );
    const existing = previous.get(`${type}:${file}`);
    const component: any = { type, name };
    if (existing?.description !== undefined)
      component.description = existing.description;
    component.src = src;
    if (existing?.fade_in !== undefined) component.fade_in = existing.fade_in;
    else if (type === 'garupa-motion') component.fade_in = 500;
    if (existing?.fade_out !== undefined)
      component.fade_out = existing.fade_out;
    else if (type === 'garupa-motion') component.fade_out = 500;
    for (const [key, value] of Object.entries(existing ?? {})) {
      if (!(key in component) && !['name', 'src'].includes(key))
        component[key] = value;
    }
    retained.push(component);
  }
  return retained;
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
  inventory?: CatalogInventory,
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
      result = await scan(gameRoot, defaultEngineRoot, inventory);
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

async function scan(
  gameRoot: string,
  defaultEngineRoot?: string,
  inventory?: CatalogInventory,
) {
  if (inventory?.cancelled) throw new Error('glTF resource index was closed');
  const changedPaths = new Set(inventory?.invalidated);
  if (inventory?.invalidated) {
    for (const path of inventory.invalidated) {
      inventory.cache?.configs.delete(path);
      inventory.cache?.shaders.delete(path);
    }
    inventory.invalidated.clear();
  }
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
  const cache: ScanCache = inventory
    ? (inventory.cache ??= { configs: new Map(), shaders: new Map() })
    : cacheFor(resolve(gameRoot));
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
  const parameterFiles: string[] = [];
  if (inventory) {
    for (const path of inventory.files) {
      if (!inside(figureRoot, path)) continue;
      if (path.endsWith(`${sep}config.json`)) configPaths.push(path);
      else if (parameterType(path)) parameterFiles.push(path);
    }
  }
  let directories = inventory ? [] : [figureRoot];
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
        if (!file.isFile()) continue;
        if (file.name === 'config.json') configPaths.push(path);
        else if (parameterType(file.name)) parameterFiles.push(path);
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
        manifest: await readMetadata(
          path,
          cache.configs,
          async () => discoveryFields(await jsonFile(path)),
          Boolean(inventory),
        ),
      };
    } catch (error) {
      return { path, error };
    }
  });
  const configDirectories = new Set(configPaths.map(dirname));
  const manifestSnapshots = new Map(
    manifests
      .filter((item) => parameterDirectory(item.manifest))
      .map((item) => [item.path, JSON.stringify(item.manifest)]),
  );
  const ownedFiles = new Map<string, string[]>();
  for (const file of parameterFiles) {
    let owner = dirname(file);
    while (inside(figureRoot, owner)) {
      if (configDirectories.has(owner)) {
        const files = ownedFiles.get(owner) ?? [];
        files.push(file);
        ownedFiles.set(owner, files);
        break;
      }
      if (owner === figureRoot) break;
      owner = dirname(owner);
    }
  }
  const parameterUpdates: { path: string; content: string }[] = [];
  const parameterPackages = (cache.parameterPackages ??= new Map());
  for (const item of manifests) {
    if (!parameterDirectory(item.manifest)) continue;
    const directory = dirname(item.path);
    const files = (ownedFiles.get(directory) ?? []).sort();
    const previousPackage = parameterPackages.get(item.path);
    const sameFiles =
      previousPackage &&
      previousPackage.files.length === files.length &&
      previousPackage.files.every((path, i) => path === files[i]);
    const components =
      previousPackage?.manifest === item.manifest && sameFiles
        ? previousPackage.components
        : parameterComponents(directory, item.manifest.components, files);
    parameterPackages.set(item.path, {
      manifest: item.manifest,
      files,
      components,
    });
    if (
      JSON.stringify(components) !== JSON.stringify(item.manifest.components)
    ) {
      item.manifest = { ...item.manifest, components };
      parameterUpdates.push({
        path: item.path,
        content: `${JSON.stringify(item.manifest, null, 2)}\n`,
      });
    }
  }
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
    const models = components.filter(
      (component) =>
        component.type === 'model' && component.role === 'integrated',
    );
    if (models.length > 1)
      issues.push(
        `${relative(
          figureRoot,
          path,
        )}: one integrated model per selectable package required`,
      );
    const config = relative(dirname(catalogPath), path)
      .split(sep)
      .map(encodeURIComponent)
      .join('/');
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
      const entry: GltfCatalogEntry = { type: component.type, name, config };
      if (['motion', 'model'].includes(component.type) && typeof component.description === 'string' && component.description.trim())
        entry.description = component.description;
      resources.push(entry);
      definitions.push({ entry, component, path });
    }
  }
  const adapters = definitions.filter(
    (definition) => definition.entry.type === 'garupa-expression-adapter',
  );
  const presentModels = new Set<string>();
  const modelCache = (cache.models ??= new Map());
  const modelIssues = await mapConcurrent(
    definitions.filter((definition) => definition.entry.type === 'model'),
    async ({ entry, component, path }) => {
      const matchingAdapters = adapters.filter(
        (definition) =>
          definition.component.motionGroup === component.motionGroup,
      );
      const context = JSON.stringify([
        matchingAdapters.map((definition) => definition.entry.name),
        identities.has(`garupa-motion:${component.defaultMotion}`),
        identities.has(`motion:${component.defaultMotion}`),
      ]);
      const cachedModel = modelCache.get(path);
      if (
        inventory &&
        cachedModel?.component === component &&
        cachedModel.context === context &&
        !changedPaths.has(cachedModel.modelPath)
      ) {
        if (cachedModel.modelPath) presentModels.add(cachedModel.modelPath);
        if (cachedModel.dependencies.length)
          entry.dependencies = cachedModel.dependencies;
        return cachedModel.issues;
      }
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
      for (const adapter of matchingAdapters) {
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
            (!(inventory && cache.shaders.has(modelPath)) &&
              !inside(figureRoot, await fs.realpath(modelPath)))
          )
            throw new Error('Model outside figure directory');
          for (const name of await readMetadata(
            modelPath,
            cache.shaders,
            () => materialShaders(modelPath),
            Boolean(inventory),
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
      modelCache.set(path, {
        component,
        context,
        modelPath:
          typeof component.model === 'string'
            ? resolve(dirname(path), component.model)
            : undefined,
        dependencies: entry.dependencies ?? [],
        issues: localIssues,
      });
      return localIssues;
    },
  );
  issues.push(...modelIssues.flat());
  // All resource identities have been checked before modifying any package.
  for (const update of parameterUpdates) {
    if (inventory?.cancelled) throw new Error('glTF resource index was closed');
    let current;
    let original;
    try {
      original = await jsonFile(update.path);
      current = discoveryFields(original);
    } catch (error) {
      if (inventory) {
        invalidateCatalogFile(inventory, update.path);
        if (error.code === 'ENOENT') inventory.files.delete(update.path);
        throw new CatalogChangedError(
          'Parameter config changed during indexing',
        );
      }
      throw error;
    }
    if (JSON.stringify(current) !== manifestSnapshots.get(update.path)) {
      if (inventory) invalidateCatalogFile(inventory, update.path);
      throw new CatalogChangedError('Parameter config changed during indexing');
    }
    const updated = JSON.parse(update.content);
    for (const component of updated.components) {
      if (component?.type !== 'model') continue;
      const source = original.components.find(item => item?.type === 'model' && item.name === component.name && item.role === component.role);
      if (source && Object.prototype.hasOwnProperty.call(source, 'preview')) component.preview = source.preview;
    }
    await replaceFile(update.path, `${JSON.stringify(updated, null, 2)}\n`);
    cache.configs.delete(update.path);
  }
  pruneMetadata(cache.configs, new Set(configPaths));
  pruneMetadata(cache.shaders, presentModels);
  for (const path of parameterPackages.keys())
    if (!configDirectories.has(dirname(path))) parameterPackages.delete(path);
  for (const path of modelCache.keys())
    if (!configDirectories.has(dirname(path))) modelCache.delete(path);
  resources.sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
  });
  const content = `${JSON.stringify(
    {
      说明: '本文件为WebGAL Terre LoveLive自动生成，请勿删除或修改，否则可能造成glTF模型与动作无法加载。若您不使用Terre进行编辑，在figure目录中增加glTF模型或动作后，需要手动编辑此文件，将其加入此列表。',
      description:
        'This file is automatically generated by WebGAL Terre LoveLive. Do not delete or modify it, as this may prevent glTF models and motions from loading. If you do not use Terre for editing, you must manually edit this file to add any glTF models or motions you add to the figure directory to this list.',
      resources,
    },
    null,
    2,
  )}\n`;
  let existing;
  try {
    existing = await fs.readFile(catalogPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing !== content) {
    if (inventory?.cancelled) throw new Error('glTF resource index was closed');
    // Never recreate a game that was removed while indexing was in progress.
    await fs.access(gameRoot);
    try {
      await fs.mkdir(dirname(catalogPath));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await replaceFile(catalogPath, content);
  }
  return { enabled: true, resources, issues };
}
