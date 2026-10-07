import * as fs from 'fs/promises';
import {
  isAbsolute,
  join,
  relative,
  sep,
} from 'path';

export function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export const urlPath = (root: string, path: string) =>
  relative(root, path).split(sep).map(encodeURIComponent).join('/');
export const namePath = (root: string, path: string) =>
  relative(root, path).split(sep).join('/');
export const jsonFile = async (path: string) =>
  JSON.parse(await fs.readFile(path, 'utf8'));
export async function walk(
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
