type ExpressionMode = '3d' | 'live2d';
let lastExpressionMode: ExpressionMode | undefined;
let lastFigure3D: boolean | undefined;

export function rememberExpressionMode(mode: ExpressionMode) {
  lastExpressionMode = mode;
}

export function preferredExpressionMode(value: string, supportsLive2D: boolean, live2d: string[]): ExpressionMode {
  if (!supportsLive2D) return '3d';
  if (value) return value.startsWith('3d:') ? '3d' : 'live2d';
  if (lastExpressionMode === '3d') return '3d';
  return live2d.length ? 'live2d' : '3d';
}

export function rememberFigureMode(is3D: boolean) {
  lastFigure3D = is3D;
}

export function preferredFigure3D(value: string): boolean {
  return value && value !== 'none' ? isGltfConfigPath(value) : lastFigure3D ?? false;
}

export interface GltfResourceEntry {
  type: string;
  name: string;
  config: string;
  description?: string;
  preview?: string;
}

export interface GltfCatalogResult {
  enabled: boolean;
  resources: GltfResourceEntry[];
  revision: number;
  issues?: unknown[];
  indexing?: boolean;
  error?: string;
}

export const LOVELIVE_ENGINE_ID = 'webgal-lovelive.lovelive';

export function isLoveliveEngine(manifest: unknown): boolean {
  return !!manifest && typeof manifest === 'object' &&
    (manifest as { id?: unknown }).id === LOVELIVE_ENGINE_ID;
}

export function isGltfConfigPath(path: string): boolean {
  return /(?:^|\/)config\.json$/i.test(path.split(/[?#]/)[0].replace(/\\/g, '/'));
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
    nativeExpressions: nativeExpressionOptions(models[0]),
    expressions: supportsLive2DExpressions
      ? uniqueNames(resources.filter(entry => entry.type === 'garupa-expression').map(entry => entry.name)) : [],
  };
}

export interface NativeExpressionSelection { eye?: string; closed?: string; open?: string }
export interface NativeExpressionOptions {
  eyes: string[];
  mouths: string[];
  defaults: NativeExpressionSelection;
}
export function nativeExpressionOptions(model: { expressionGroups?: any[]; defaultExpression?: NativeExpressionSelection }): NativeExpressionOptions {
  const groups = Array.isArray(model.expressionGroups) ? model.expressionGroups : [];
  const names = (type: string) => (groups.find(group => group.type === type)?.states ?? [])
    .map((state: { name: string }) => state.name);
  const eyes = names('eye'), mouths = names('mouth');
  return { eyes, mouths, defaults: model.defaultExpression ?? {
    ...(eyes.length ? { eye: eyes[0] } : {}), ...(mouths.length ? { closed: mouths[0], open: mouths[0] } : {}),
  } };
}
export function encodeNativeExpression(selection: NativeExpressionSelection): string {
  return `3d:${[selection.eye, selection.closed, selection.open].map(name => encodeURIComponent(name ?? '')).join('/')}`;
}
export function decodeNativeExpression(value: string): NativeExpressionSelection | null {
  if (!value.startsWith('3d:')) return null;
  const parts = value.slice(3).split('/');
  if (parts.length !== 3) return null;
  try {
    const [eye, closed, open] = parts.map(decodeURIComponent);
    return { ...(eye ? { eye } : {}), ...(closed ? { closed } : {}), ...(open ? { open } : {}) };
  } catch { return null; }
}
