import { BadRequestException, Injectable } from '@nestjs/common';
import { join, resolve } from 'path';
import * as fs from 'fs/promises';
import { UserDataService } from '../user-data/user-data.service';
import { checkFileName } from '../../util/checkFileName';
import { GltfResourceIndexService } from './gltf-resource-index.service';
import { browseGltfModels, readGltfModel, modelShaderNames } from './gltf-model-packages';
import { scanGltfRuntimes } from './gltf-runtime-registry';
import { gltfEnabled, inside } from './gltf-files';

@Injectable()
export class GltfService {
  constructor(private readonly index: GltfResourceIndexService) {}

  async updateGltfResourceCatalog(gameName: string, revision?: number) {
    if (
      typeof gameName !== 'string' ||
      !checkFileName(gameName) ||
      !gameName ||
      gameName === '.' ||
      gameName === '..'
    ) {
      throw new BadRequestException('Invalid game name');
    }
    const result = await this.index.getGltfCatalog(gameName);
    if (revision === result.revision) {
      const { resources, issues, ...status } = result;
      return { ...status, unchanged: true };
    }
    return result;
  }

  async gltfCatalogSession(gameName: string, sessionId: string, active: boolean) {
    if (typeof gameName !== 'string' || !gameName || !checkFileName(gameName) || gameName === '.' || gameName === '..' ||
        typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 128 || typeof active !== 'boolean') {
      throw new BadRequestException('Invalid catalog session');
    }
    return this.index.gltfCatalogSession(gameName, sessionId, active);
  }

  private gltfGameRoot(gameName: string) {
    if (typeof gameName !== 'string' || !gameName || !checkFileName(gameName) || ['.', '..'].includes(gameName))
      throw new BadRequestException('Invalid game name');
    return join(UserDataService.getGameRoot(), gameName);
  }

  async browseGltfModels(gameName: string, directory: string) {
    const root = this.gltfGameRoot(gameName);
    if (typeof directory !== 'string') throw new BadRequestException('Invalid model directory');
    if (!await gltfEnabled(root, UserDataService.getEngineTemplateRoot())) return { enabled: false, models: [], issues: [] };
    try { return { enabled: true, ...await browseGltfModels(root, directory) }; }
    catch (error) { throw new BadRequestException(error.message); }
  }

  async selectGltfModel(gameName: string, path: string) {
    const root = this.gltfGameRoot(gameName);
    if (typeof path !== 'string') throw new BadRequestException('Invalid model path');
    if (!await gltfEnabled(root, UserDataService.getEngineTemplateRoot())) throw new BadRequestException('当前引擎不支持 glTF 3D模型');
    try {
      const model = await readGltfModel(root, path);
      const required = (Array.isArray(model.behaviors) ? model.behaviors : []).filter(item => item?.required !== false).map(item => item?.name).filter(name => typeof name === 'string')
        .map(name => `behavior:${name}`);
      required.push(...(await modelShaderNames(root, model)).map(name => `shader:${name}`));
      const runtimeRoot = join(root, 'game/3d/runtime');
      const names = new Set<string>();
      try {
        const index = JSON.parse(await fs.readFile(join(runtimeRoot, 'index.json'), 'utf8'));
        for (const config of index.packages ?? []) {
          const file = resolve(runtimeRoot, ...config.split('/').map(decodeURIComponent));
          if (!inside(runtimeRoot, file) || !inside(runtimeRoot, await fs.realpath(file))) throw new Error('运行时包路径超出 3d/runtime');
          const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
          for (const component of manifest.components ?? [])
            if (component?.type === 'behavior') names.add(`behavior:${component.namespace}.${component.name}`);
            else if (component?.type === 'shader') names.add(`shader:${component.name}`);
            else if (component?.type === 'garupa-expression-adapter' && component.motionGroup === model.motionGroup) names.add('adapter');
        }
      } catch {}
      let missing = required.filter(name => !names.has(name));
      if (missing.length || (model.motionGroup && !names.has('adapter'))) {
        const runtime = await scanGltfRuntimes(root);
        this.index.updateGltfRuntimes(gameName, runtime);
        const known = new Set(runtime.resources.map(item => `${item.type}:${item.name}`));
        missing = required.filter(name => !known.has(name));
        if (runtime.issues.length) throw new Error(runtime.issues.join('\n'));
      }
      if (missing.length) throw new Error(`缺少模型依赖: ${missing.join(', ')}`);
      return model;
    } catch (error) { throw new BadRequestException(error.message); }
  }

}
