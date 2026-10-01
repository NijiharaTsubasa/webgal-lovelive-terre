export interface GltfResourceEntry {
  type: string;
  name: string;
  config: string;
  description?: string;
}

export interface GltfCatalogResult {
  enabled: boolean;
  resources: GltfResourceEntry[];
  issues?: unknown[];
}

export const LOVELIVE_ENGINE_ID = 'webgal-lovelive.lovelive';

export function isLoveliveEngine(manifest: unknown): boolean {
  return !!manifest && typeof manifest === 'object' &&
    (manifest as { id?: unknown }).id === LOVELIVE_ENGINE_ID;
}

export function isGltfConfigPath(path: string): boolean {
  return /(?:^|\/)config\.json$/i.test(path.split(/[?#]/)[0].replace(/\\/g, '/'));
}

export function catalogFigurePaths(resources: GltfResourceEntry[]): Set<string> {
  const base = 'https://resource.invalid/gltf-resources.json';
  const paths = new Set<string>();
  for (const resource of resources) {
    if (resource.type !== 'model') continue;
    const url = new URL(resource.config, base);
    if (url.origin === 'https://resource.invalid' && url.pathname.startsWith('/figure/')) {
      paths.add(decodeURIComponent(url.pathname.slice('/figure/'.length)));
    }
  }
  return paths;
}

export function canChooseFigureFile(path: string, enabled: boolean): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^figure\//, '');
  return !isGltfConfigPath(normalized) || enabled;
}

export function gltfFigureSelectionError(config: unknown): string | null {
  if (!config || typeof config !== 'object' || !('components' in config)) return null;
  const components = Array.isArray(config.components) ? config.components : [];
  const models = components.filter(component => component?.type === 'model' && component.role === 'integrated');
  if (models.length > 1) return '暂不支持一个配置包含多个glTF 3D模型';
  if (models.length === 1) return null;
  const types = [...new Set(components.map(component => {
    if (typeof component?.type !== 'string') return '未声明';
    return component.type === 'model' && typeof component.role === 'string'
      ? `${component.type}（${component.role}）` : component.type;
  }))].join('、') || '未声明';
  return `所选文件不是有效的glTF 3D模型（当前文件种类:${types}）`;
}

export function gltfFigureOptions(config: unknown, resources: GltfResourceEntry[], adapterConfigs: unknown[] = []) {
  const components = config && typeof config === 'object'
    ? (config as { components?: unknown }).components : undefined;
  if (!Array.isArray(components)) return null;
  const models = components.filter(component => component?.type === 'model' && component.role === 'integrated');
  if (models.length !== 1 || typeof models[0].model !== 'string') return null;
  const supportsLive2DExpressions = typeof models[0].motionGroup === 'string' && adapterConfigs.some(config => {
    const components = config && typeof config === 'object' ? (config as { components?: unknown }).components : undefined;
    return Array.isArray(components) && components.some(component => component?.type === 'garupa-expression-adapter'
      && component.motionGroup === models[0].motionGroup);
  });
  const uniqueNames = (names: unknown[]) => [...new Set(names.filter((name): name is string => typeof name === 'string' && !!name))]
    .sort((a, b) => a.localeCompare(b));
  return {
    supportsLive2DExpressions,
    motions: uniqueNames(resources.filter(entry => entry.type === 'motion' || entry.type === 'garupa-motion').map(entry => entry.name)),
    expressions: uniqueNames([
      ...(Array.isArray(models[0].expressions) ? models[0].expressions.map((expression: { name?: unknown }) => expression?.name) : []),
      ...(supportsLive2DExpressions ? resources.filter(entry => entry.type === 'garupa-expression').map(entry => entry.name) : []),
    ]),
  };
}
