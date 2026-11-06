import { useContext, useMemo } from 'react';
import axios from 'axios';
import useSWR from 'swr';
import { createModelPreviewLoader, modelAssetMap } from '@/utils/gltf/modelAssets';
import { ModelPreviewRoleContext } from '@/utils/gltf/ModelPreviewRoleContext';

interface BrowsedModel {
  path: string;
  name: string;
  description?: string;
  preview?: string;
  role: 'integrated' | 'head' | 'body' | 'composed';
}

export default function useModelAssets(rootPath: string[], currentFullPath: string[]) {
  const role = useContext(ModelPreviewRoleContext);
  const game = rootPath[0] === 'games' && rootPath[2] === 'game' ? rootPath[1] : undefined;
  const enabled = !!game && currentFullPath[3] === '3d' && currentFullPath[4] === 'figure';
  const directory = currentFullPath.slice(5).join('/');
  const { data, mutate, error } = useSWR<{ models: BrowsedModel[] }>(enabled ? ['gltf-model-directory', game, directory, role] : null,
    async () => (await axios.post('/api/manageGame/browseGltfModels', { gameName: game, directory, ...(role ? {role} : {}) })).data,
    { revalidateOnFocus: false });
  const models = useMemo(() => {
    const result = modelAssetMap(rootPath, (data?.models ?? []).map(model => ({
      type: 'model', name: model.name, description: model.description, preview: model.preview, role,
      config: ['3d/figure', model.path.split('/').map(encodeURIComponent).join('/'), 'config.json'].filter(Boolean).join('/'),
    })), enabled);
    return result;
  }, [data, rootPath.join('/'), enabled, role]);
  const incompatibleModelPaths = useMemo(() => {
    const paths = new Set<string>();
    if (!role) return paths;
    const opposite = role === 'head' ? 'body' : 'head';
    for (const model of data?.models ?? []) {
      if (model.role !== opposite) continue;
      const folder = model.path ? `3d/figure/${model.path}` : '3d/figure';
      paths.add(folder);
      paths.add(`${folder}/config.json`);
    }
    return paths;
  }, [data, role]);
  const loadPreview = useMemo(() => createModelPreviewLoader(async url => (await axios.get(url)).data), [game, data, role]);
  return { models, incompatibleModelPaths, loadPreview, refreshModels: mutate,
    indexError: error ? '无法读取模型目录。' : undefined };
}
