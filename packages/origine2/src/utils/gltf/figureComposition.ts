export type FigureRole = 'head' | 'body';
export interface FigurePart {
  role: FigureRole;
  name: string;
  description?: string;
  preview?: string;
  group?: string;
  renderProfile?: string;
  configPath: string;
  [key: string]: unknown;
}

export function splitFigureConfigs(path: string): string[] {
  const pieces = path.split(/config\.json\+/i);
  return pieces.map((part, index) => (index < pieces.length - 1 ? `${part}config.json` : part));
}

export function figurePartConfig(config: unknown): Array<Record<string, any>> {
  const components = config && typeof config === 'object' ? (config as { components?: unknown }).components : undefined;
  if (!Array.isArray(components)) return [];
  const models = components.filter((part) => part?.type === 'model');
  if (['head', 'body', 'integrated'].some((role) => models.filter((part) => part.role === role).length > 1))
    throw Error('所选配置包含多个同类模型');
  return models;
}

export function figureCombinationError(head?: FigurePart, body?: FigurePart): string {
  if (!head || !body) return '';
  if (!head.group || head.group !== body.group) return '所选头部和身体不属于同一模型组，无法组合。';
  if (head.renderProfile !== body.renderProfile) return '所选头部和身体的渲染方式不同，无法组合。';
  return '';
}
