import { createContext, useCallback, useEffect } from 'react';
import axios from 'axios';
import useSWR from 'swr';
import { GltfCatalogResult } from '@/utils/gltf/gltfFigure';

const EMPTY_CATALOG: GltfCatalogResult = { enabled: false, resources: [], revision: 0 };
export const GltfCatalogEnabledContext = createContext(false);
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
// The editor session receives change notifications; controls share the cache.
export default function useGltfCatalog(game: string | undefined) {
  const result = useSWR<GltfCatalogResult>(game ? ['gltf-catalog', game] : null,
    () => readCatalog(game!),
    { revalidateOnFocus: false, revalidateOnReconnect: false });
  const refresh = useCallback(async () => {
    try { return await result.mutate(); }
    catch { return undefined; }
  }, [result.mutate]);
  return { catalog: result.data ?? EMPTY_CATALOG, refresh, error: result.error };
}

export function useGltfCatalogSession(game: string | undefined) {
  const { refresh } = useGltfCatalog(game);
  useEffect(() => {
    if (!game) return;
    let session: EventSource;
    let disposed = false;
    let refreshing = false;
    let refreshAgain = false;
    const synchronize = async () => {
      refreshAgain = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (refreshAgain) {
          if (disposed) break;
          refreshAgain = false;
          await refresh();
        }
      } finally { refreshing = false; }
    };
    const changed = (event: MessageEvent) => {
      try {
        const status = JSON.parse(event.data);
        const previous = snapshots.get(game);
        if (!refreshing && previous && previous.revision === status.revision && previous.enabled === status.enabled &&
          Boolean(previous.indexing) === Boolean(status.indexing) && previous.error === status.error) return;
      } catch { /* A full read can recover from an unreadable notification. */ }
      synchronize();
    };
    const connect = () => {
      if (!session || session.readyState === EventSource.CLOSED) {
        session = new EventSource(`/api/manageGame/gltfCatalogSession?gameName=${encodeURIComponent(game)}`);
        // Fires on both initial connection and automatic reconnection.
        session.onopen = () => { synchronize(); };
        session.addEventListener('catalog', changed);
      }
    };
    const release = () => {
      if (session) {
        session.onopen = null;
        session.removeEventListener('catalog', changed);
        session.close();
      }
    };
    // Connection lifetime survives background timer throttling. EventSource
    // reconnects after transport failures; pageshow restores a bfcache page.
    connect();
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', connect);
    return () => {
      disposed = true;
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', connect);
      release();
    };
  }, [game, refresh]);
}
