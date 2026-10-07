import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs/promises';
import { join } from 'path';
import { GltfCatalogIndex } from './gltf-catalog-index';
import { scanGltfRuntimes } from './gltf-runtime-registry';
import type { GltfCatalogSnapshot } from './gltf-catalog-worker-client';

const { root, engineRoot, gameName } = workerData;
const post = (message: any) => parentPort.postMessage(message);
const failure = (error: Error) => post({ type: 'error', error: error.message });
let initialSnapshot: GltfCatalogSnapshot;
let lastWarning = 0;
let suppressedWarnings = 0;
function warning(error: Error) {
  if (Date.now() - lastWarning < 5000) {
    suppressedWarnings++;
    return;
  }
  post({
    type: 'warning',
    error: suppressedWarnings
      ? `${error.message}（另有 ${suppressedWarnings} 条文件监听警告已合并）`
      : error.message,
  });
  suppressedWarnings = 0;
  lastWarning = Date.now();
}
const index = new GltfCatalogIndex(
  root,
  engineRoot,
  warning,
  gameName,
  (message) => post({ type: 'progress', message }),
  (snapshot) =>
    post({
      type: 'snapshot',
      snapshot:
        snapshot.revision === 0 && initialSnapshot
          ? {
              ...snapshot,
              enabled: initialSnapshot.enabled,
              resources: initialSnapshot.resources,
              issues: initialSnapshot.issues,
            }
          : snapshot,
    }),
);

async function bootstrap() {
  const gameRoot = join(root, gameName);
  let selectedEngine = engineRoot;
  try {
    await fs.access(join(gameRoot, 'index.html'));
    selectedEngine = gameRoot;
  } catch {}
  let snapshot: GltfCatalogSnapshot = {
    enabled: false,
    resources: [],
    issues: [],
    revision: 0,
    indexing: true,
  };
  try {
    const engine = JSON.parse(
      await fs.readFile(join(selectedEngine, 'webgal-engine.json'), 'utf8'),
    );
    snapshot.enabled = engine?.id === 'webgal-lovelive.lovelive';
  } catch {}
  if (!snapshot.enabled) snapshot.indexing = false;
  else snapshot.revision = -1;
  initialSnapshot = snapshot;
  post({ type: 'snapshot', snapshot });
  if (snapshot.enabled) {
    // Runtime registration must be ready before large motion discovery begins.
    const runtime = await scanGltfRuntimes(gameRoot);
    initialSnapshot = { ...snapshot, ...runtime, revision: 0 };
    post({ type: 'snapshot', snapshot: initialSnapshot });
    index.setRuntimes(runtime);
    await index.get(gameName);
  }
}

// Preserve ordering for explicit writes and export requests; external watcher updates
// are published by the index callback without timer-driven rescans.
let operations = bootstrap().catch(failure);
const pendingPaths = new Set<string>();
let notificationTimer: ReturnType<typeof setTimeout>;
async function flushNotifications() {
  clearTimeout(notificationTimer);
  notificationTimer = undefined;
  const paths = [...pendingPaths];
  pendingPaths.clear();
  if (!initialSnapshot?.enabled) {
    post({ type: 'snapshot', snapshot: initialSnapshot });
    return;
  }
  for (const path of paths) await index.notify(path, false);
  if (paths.length) {
    const result = await index.get(gameName);
    post({ type: 'snapshot', snapshot: { ...result, indexing: false } });
  }
}
parentPort.on('message', (message) => {
  if (message.type === 'notify') {
    pendingPaths.add(message.path);
    clearTimeout(notificationTimer);
    notificationTimer = setTimeout(() => {
      operations = operations.then(flushNotifications).catch(failure);
    }, 500);
    return;
  }
  operations = operations.then(async () => {
    try {
      if (message.type === 'settled') {
        await flushNotifications();
        const result = initialSnapshot?.enabled ? await index.get(gameName) : initialSnapshot;
        post({
          requestId: message.requestId,
          snapshot: { ...result, indexing: false },
        });
      } else if (message.type === 'runtime') {
        index.setRuntimes(message.runtime);
        const result = await index.get(gameName);
        post({ type: 'snapshot', snapshot: { ...result, indexing: false } });
      }
    } catch (error) {
      if (message.requestId !== undefined)
        post({ requestId: message.requestId, error: error.message });
      else failure(error);
    }
  });
});
