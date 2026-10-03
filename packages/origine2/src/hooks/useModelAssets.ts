import { useMemo } from 'react';
import axios from 'axios';
import useSWR from 'swr';
import { GltfCatalogResult, isLoveliveEngine } from '@/utils/gltfFigure';
import { createModelPreviewLoader, modelAssetMap } from '@/utils/modelAssets';

export default function useModelAssets(rootPath: string[], currentFullPath: string[]) {
  const game = rootPath[0] === 'games' && rootPath[2] === 'game' ? rootPath[1] : undefined;
  const inFigure = currentFullPath[3] === 'figure';
  const { data: engine } = useSWR(game && inFigure ? `/games/${encodeURIComponent(game)}/webgal-engine.json` : null,
    async url => (await axios.get(url)).data);
  const enabled = !!game && inFigure && isLoveliveEngine(engine);
  const { data: catalog, mutate: refreshModels } = useSWR<GltfCatalogResult>(
    enabled ? ['model-assets', game, currentFullPath.join('/')] : null,
    async () => (await axios.post('/api/manageGame/updateGltfResourceCatalog', { gameName: game })).data,
  );
  const models = useMemo(() => modelAssetMap(rootPath, catalog?.resources ?? [], enabled && !!catalog?.enabled),
    [rootPath.join('/'), catalog, enabled]);
  const loadPreview = useMemo(() => createModelPreviewLoader(async url => (await axios.get(url)).data),
    [game, catalog?.revision]);
  return { models, loadPreview, refreshModels };
}
