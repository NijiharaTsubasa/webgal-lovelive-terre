import * as fs from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { inside, jsonFile, namePath, urlPath } from './gltf-files';

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
