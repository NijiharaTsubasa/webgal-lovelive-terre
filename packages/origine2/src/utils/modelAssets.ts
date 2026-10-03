import type { GltfResourceEntry } from './gltfFigure';

export interface ModelAssetInfo {
  name: string;
  description?: string;
  configUrl: string;
}

export function modelAssetMap(rootPath: string[], resources: GltfResourceEntry[], enabled: boolean) {
  const models = new Map<string, ModelAssetInfo>();
  if (!enabled || rootPath[0] !== 'games' || !rootPath[1] || rootPath[2] !== 'game') return models;
  const gameRoot = `/games/${encodeURIComponent(rootPath[1])}/game/`;
  const root = rootPath.slice(3).join('/');
  for (const resource of resources) {
    if (resource.type !== 'model') continue;
    try {
      const url = new URL(resource.config, `https://resource.invalid${gameRoot}gltf-resources.json`);
      if (url.origin !== 'https://resource.invalid' || !url.pathname.startsWith(`${gameRoot}figure/`)) continue;
      const path = url.pathname.slice(gameRoot.length).split('/').map(decodeURIComponent).join('/');
      if (!path.endsWith('/config.json') || (root && !path.startsWith(`${root}/`))) continue;
      const configPath = root ? path.slice(root.length + 1) : path;
      const info = { name: resource.name, description: resource.description, configUrl: url.pathname };
      models.set(configPath, info);
      models.set(configPath.slice(0, configPath.lastIndexOf('/')), info);
    } catch { /* Invalid catalog paths are not selectable model metadata. */ }
  }
  return models;
}

export function modelPreview(config: unknown, name: string): string | undefined {
  const components = config && typeof config === 'object' ? (config as { components?: unknown }).components : undefined;
  if (!Array.isArray(components)) return;
  const models = components.filter(item => item?.type === 'model' && item.role === 'integrated');
  if (models.length !== 1 || models[0].name !== name) return;
  const preview = models[0].preview;
  return typeof preview === 'string' && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(preview) ? preview : undefined;
}

/** A bounded cache owned by one catalog revision; requests retain no full config. */
export function createModelPreviewLoader(read: (url: string) => Promise<unknown>, limit = 12) {
  const cache = new Map<string, Promise<string | undefined>>();
  return (model: ModelAssetInfo) => {
    const key = `${model.configUrl}\n${model.name}`;
    let result = cache.get(key);
    if (!result) {
      result = read(model.configUrl).then(config => modelPreview(config, model.name)).catch(() => {
        cache.delete(key);
        return undefined;
      });
      cache.set(key, result);
      if (cache.size > limit) cache.delete(cache.keys().next().value!);
    }
    return result;
  };
}

export function scheduleModelPreview(load: () => Promise<string | undefined>, receive: (preview: string | undefined) => void) {
  let active = true;
  const timer = setTimeout(() => { void load().then(preview => { if (active) receive(preview); }); }, 200);
  return () => { active = false; clearTimeout(timer); };
}
