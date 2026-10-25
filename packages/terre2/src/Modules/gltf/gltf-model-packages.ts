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
export type GltfModelRole = 'head' | 'body';

export async function readGltfModel(gameRoot: string, modelPath: string, role?: GltfModelRole) {
  if (/config\.json\+/.test(modelPath)) {
    const paths = modelPath.split(/(?<=config\.json)\+/);
    if (paths.length !== 2 || paths.some(path => !/(?:^|\/)config\.json$/.test(path)))
      throw new Error('头身组合路径必须依次指定头部和身体的 config.json');
    const head = await readGltfModel(gameRoot, paths[0], 'head');
    const body = await readGltfModel(gameRoot, paths[1], 'body');
    if (head.role !== 'head' || body.role !== 'body')
      throw new Error('头身组合必须依次选择头部和身体，不能使用完整模型代替');
    if (!head.group || head.group !== body.group)
      throw new Error('所选头部与身体的模型分组不兼容');
    if (head.renderProfile !== body.renderProfile)
      throw new Error('所选头部与身体的渲染配置不兼容');
    const parts = [head.parts[0], body.parts[0]];
    return { ...body, role: 'composed', expressionGroups: head.expressionGroups,
      defaultExpression: head.defaultExpression, preview: head.preview,
      parts, selectionParts: parts };
  }
  const root = join(gameRoot, 'game', '3d', 'figure');
  const directory = resolve(
    root,
    /(?:^|\/)config\.json$/.test(modelPath) ? dirname(modelPath) : modelPath,
  );
  if (!inside(root, directory) || !inside(root, await fs.realpath(directory)))
    throw new Error('模型路径超出 3d/figure');
  const path = join(directory, 'config.json'),
    manifest = await jsonFile(path);
  if (!Array.isArray(manifest?.components))
    throw new Error('所选文件不是有效的 glTF 3D模型');
  const models = manifest.components.filter(component => component?.type === 'model');
  const heads = models.filter(component => component.role === 'head');
  const bodies = models.filter(component => component.role === 'body');
  const integrated = models.filter(component => component.role === 'integrated');
  if (heads.length > 1 || bodies.length > 1)
    throw new Error('不支持一个配置包含多个头部或多个身体，请选择只包含一个头部和一个身体的模型配置');
  if (integrated.length > 1) throw new Error('暂不支持一个配置包含多个glTF 3D模型');
  if (!models.length)
    throw new Error(
      `所选文件不是有效的 glTF 3D模型（当前文件种类:${manifest.components
        .map((component) => component?.type)
        .join(', ')}）`,
    );
  const composed = models.length === 2 && heads.length === 1 && bodies.length === 1;
  if (!composed && !(models.length === 1 && ['integrated', 'head', 'body'].includes(models[0].role)))
    throw new Error('所选配置必须包含一个完整模型、单独的头部或身体，或恰好一个头部和一个身体');
  const selection = role && !integrated.length ? models.filter(component => component.role === role)
    : composed ? [heads[0], bodies[0]] : models;
  if (!selection.length) throw new Error(`所选模型包只包含${role === 'head' ? '身体' : '头部'}`);
  const model = selection.length === 2 ? { ...bodies[0], role: 'composed', expressionGroups: heads[0].expressionGroups,
    defaultExpression: heads[0].defaultExpression, preview: heads[0].preview } : selection[0];
  const config = urlPath(join(gameRoot, 'game'), path), relativePath = namePath(root, directory);
  const parts = selection.map(component => ({ ...component, config, path: relativePath }));
  return {
    ...model,
    parts,
    selectionParts: parts,
    config,
    path: relativePath,
  };
}
export async function browseGltfModels(gameRoot: string, directory: string, role?: GltfModelRole) {
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
          const complete = await readGltfModel(gameRoot, candidate);
          const selected = role ? complete.selectionParts.find(part => part.role === role) : undefined;
          const { parts, selectionParts, ...model } = selected ?? complete;
          // Keep model folders selectable so a missing part is reported before entering them.
          if (role && !selected && model.role !== 'integrated') model.preview = undefined;
          models.push(model);
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
