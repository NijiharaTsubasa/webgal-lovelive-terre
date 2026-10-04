import { useMemo } from 'react';
import axios from 'axios';
import useSWR from 'swr';
import { createModelPreviewLoader, modelAssetMap } from '@/utils/modelAssets';

export default function useModelAssets(rootPath: string[], currentFullPath: string[]) {
  const game = rootPath[0] === 'games' && rootPath[2] === 'game' ? rootPath[1] : undefined;
  const enabled = !!game && currentFullPath[3] === '3d' && currentFullPath[4] === 'figure';
  const directory = currentFullPath.slice(5).join('/');
  const { data, mutate, error } = useSWR(enabled ? ['gltf-model-directory', game, directory] : null,
    async () => (await axios.post('/api/manageGame/browseGltfModels', { gameName: game, directory })).data,
    { revalidateOnFocus: false });
  const models = useMemo(() => {
    const result = modelAssetMap(rootPath, (data?.models ?? []).map((model: { path: string; name: string; description?: string; preview?: string }) => ({
      type: 'model', name: model.name, description: model.description, preview: model.preview,
      config: ['3d/figure', model.path.split('/').map(encodeURIComponent).join('/'), 'config.json'].filter(Boolean).join('/'),
    })), enabled);
    return result;
  }, [data, rootPath.join('/'), enabled]);
  const loadPreview = useMemo(() => createModelPreviewLoader(async url => (await axios.get(url)).data), [game, data]);
  return { models, loadPreview, refreshModels: mutate, revision: 0, indexing: false,
    indexError: error ? '无法读取模型目录。' : undefined };
}
