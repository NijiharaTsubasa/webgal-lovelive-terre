import * as fs from 'fs/promises';
import { basename, join } from 'path';
import type { GltfCatalogEntry } from './gltf-resource-types';
import { walk, jsonFile, urlPath, namePath } from './gltf-files';

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
