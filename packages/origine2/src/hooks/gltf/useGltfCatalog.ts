import { useCallback, useEffect } from 'react';
import axios from 'axios';
import useSWR from 'swr';
import { v4 as uuidv4 } from 'uuid';
import { GltfCatalogResult } from '@/utils/gltf/gltfFigure';

const EMPTY_CATALOG: GltfCatalogResult = { enabled: false, resources: [], revision: 0 };
const requests = new Map<string, Promise<GltfCatalogResult>>();
const snapshots = new Map<string, GltfCatalogResult>();
type CatalogReply = (GltfCatalogResult & { unchanged?: false }) | {
  unchanged: true; enabled: boolean; revision: number; indexing?: boolean; error?: string;
};

function readCatalog(game: string) {
  const pending = requests.get(game);
  if (pending) return pending;
  const previous = snapshots.get(game);
  const request = axios.post<CatalogReply>('/api/manageGame/updateGltfResourceCatalog', {
    gameName: game, ...(previous ? { revision: previous.revision } : {}),
  }).then(({ data }) => {
    if (data.unchanged) {
      // Conditional responses change status without transferring the resource
      // table again. A successful retry also clears an earlier error.
      const snapshot = { ...previous!, enabled: data.enabled, revision: data.revision,
        indexing: data.indexing, error: data.error };
      snapshots.set(game, snapshot);
      return snapshot;
    }
    snapshots.set(game, data);
    return data;
  }).finally(() => requests.delete(game));
  requests.set(game, request);
  return request;
}

// One motion/expression cache per project is shared by the controls.
// Only the editor provider polls it; consumers can request an immediate refresh.
export default function useGltfCatalog(game: string | undefined, monitor = false) {
  const result = useSWR<GltfCatalogResult>(game ? ['gltf-catalog', game] : null,
    () => readCatalog(game!),
    { refreshInterval: monitor ? data => data?.indexing ? 750 : 5000 : 0, revalidateOnFocus: monitor });
  const refresh = useCallback(async () => {
    try { return await result.mutate(); }
    catch { return undefined; }
  }, [result.mutate]);
  return { catalog: result.data ?? EMPTY_CATALOG, refresh, error: result.error };
}

export function useGltfCatalogSession(game: string) {
  useEffect(() => {
    const sessionId = uuidv4();
    const body = { gameName: game, sessionId };
    const controller = new AbortController();
    const heartbeat = () => {
      void axios.post('/api/manageGame/gltfCatalogSession', { ...body, active: true }, { signal: controller.signal })
        .catch(error => { if (!controller.signal.aborted) console.warn('glTF project session could not be renewed:', error); });
    };
    const release = () => {
      // keepalive also reaches the backend when the browser tab is closing.
      void fetch('/api/manageGame/gltfCatalogSession', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, active: false }), keepalive: true,
      }).catch(() => {});
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 10000);
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', heartbeat);
    return () => {
      window.clearInterval(timer);
      controller.abort();
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', heartbeat);
      release();
    };
  }, [game]);
  useGltfCatalog(game, true);
}
