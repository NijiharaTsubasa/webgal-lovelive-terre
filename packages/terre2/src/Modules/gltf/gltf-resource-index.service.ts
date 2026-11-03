import { ConsoleLogger, Injectable, OnModuleDestroy } from '@nestjs/common';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { UserDataService } from '../user-data/user-data.service';
import { GltfCatalogWorkerClient } from './gltf-catalog-worker-client';
import { gltfEnabled } from './gltf-files';
import { scanGltfRuntimes } from './gltf-runtime-registry';

@Injectable()
export class GltfResourceIndexService implements OnModuleDestroy {
  constructor(private readonly logger: ConsoleLogger) {}

  private catalogIndexes = new Map<string, GltfCatalogWorkerClient>();
  private catalogRoot?: string;
  private catalogOpening?: Promise<GltfCatalogWorkerClient>;
  private catalogSessions = new Map<string, Set<string>>();
  private catalogReads = new Map<string, number>();
  private catalogClosing = new Map<string, Promise<void>>();
  private catalogIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private catalogSuspensions = new Map<string, number>();
  private catalogEpoch = 0;
  private catalogEpochs = new Map<string, { index: GltfCatalogWorkerClient; revision: number; value: number }>();
  private catalogSnapshots = new Map<string, any>();

  private catalogListeners = new Map<string, Set<() => void>>();
  private catalogChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  watchGltfCatalog(gameName: string, listener: () => void) {
    let listeners = this.catalogListeners.get(gameName);
    if (!listeners) {
      listeners = new Set();
      this.catalogListeners.set(gameName, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        this.catalogListeners.delete(gameName);
        const timer = this.catalogChangeTimers.get(gameName);
        if (timer) clearTimeout(timer);
        this.catalogChangeTimers.delete(gameName);
      }
    };
  }

  getGltfCatalogStatus(gameName: string) {
    const { resources, issues, ...status } = this.catalogSnapshot(gameName, this.catalogIndexes.get(gameName));
    return status;
  }

  private scheduleCatalogChange(gameName: string) {
    if (!this.catalogListeners.get(gameName)?.size || this.catalogChangeTimers.has(gameName)) return;
    // Coalesce bursts without postponing updates indefinitely during long imports.
    const timer = setTimeout(() => {
      this.catalogChangeTimers.delete(gameName);
      for (const listener of this.catalogListeners.get(gameName) ?? []) listener();
    }, 250);
    timer.unref();
    this.catalogChangeTimers.set(gameName, timer);
  }

  async gltfCatalogSession(gameName: string, sessionId: string, active: boolean) {
    const root = UserDataService.getGameRoot();
    if (this.catalogRoot !== undefined && this.catalogRoot !== root) await this.onModuleDestroy();
    this.catalogRoot = root;
    let sessions = this.catalogSessions.get(gameName);
    if (!sessions) {
      sessions = new Set();
      this.catalogSessions.set(gameName, sessions);
    }
    if (active) {
      // The session belongs to an open event stream, not a browser timer lease.
      sessions.add(sessionId);
      const timer = this.catalogIdleTimers.get(gameName);
      if (timer) clearTimeout(timer);
      this.catalogIdleTimers.delete(gameName);
      // A reconnect may arrive while the previous worker is still draining.
      // Snapshot reads stay non-blocking, but a live connection must eventually
      // own a worker even when no catalog read is pending.
      if (this.catalogClosing.has(gameName)) await this.catalogClosing.get(gameName);
      if (this.catalogSessions.get(gameName)?.has(sessionId)) await this.getCatalogIndex(gameName);
    } else {
      sessions.delete(sessionId);
      if (!sessions.size) this.catalogReads.delete(gameName);
      this.releaseUnusedCatalog(gameName);
    }
    return { ok: true };
  }

  private releaseUnusedCatalog(gameName: string) {
    if (this.catalogSessions.get(gameName)?.size || this.catalogIdleTimers.has(gameName)) return;
    const timer = setTimeout(() => {
      this.catalogIdleTimers.delete(gameName);
      if (this.catalogSessions.get(gameName)?.size) return;
      if ((this.catalogReads.get(gameName) ?? -Infinity) + 30000 > Date.now()) {
        this.releaseUnusedCatalog(gameName);
        return;
      }
      const index = this.catalogIndexes.get(gameName);
      this.catalogIndexes.delete(gameName);
      this.catalogSessions.delete(gameName);
      this.catalogReads.delete(gameName);
      if (index) {
        this.catalogSnapshots.set(gameName, this.catalogSnapshot(gameName, index));
        void this.closeCatalog(gameName, index).catch(error => this.logger.warn(`glTF 索引关闭失败: ${error.message}`));
      }
    }, Math.max(10000, (this.catalogReads.get(gameName) ?? -Infinity) + 30000 - Date.now()));
    timer.unref();
    this.catalogIdleTimers.set(gameName, timer);
  }

  private closeCatalog(gameName: string, index: GltfCatalogWorkerClient) {
    const closing = Promise.resolve().then(() => index.close()).finally(() => {
      if (this.catalogClosing.get(gameName) === closing) this.catalogClosing.delete(gameName);
    });
    this.catalogClosing.set(gameName, closing);
    return closing;
  }

  private catalogSnapshot(gameName: string, index?: GltfCatalogWorkerClient) {
    if (!index) return { ...(this.catalogSnapshots.get(gameName) ?? { enabled: false, resources: [], issues: [], revision: 0 }), indexing: Boolean(this.catalogSuspensions.get(gameName)) };
    const snapshot = index.snapshot();
    const previous = this.catalogSnapshots.get(gameName);
    let revision = this.catalogEpochs.get(gameName);
    if (!revision || revision.index !== index || revision.revision !== snapshot.revision) {
      revision = { index, revision: snapshot.revision, value: ++this.catalogEpoch };
      this.catalogEpochs.set(gameName, revision);
    }
    const result = {
      ...snapshot,
      ...(snapshot.indexing && !snapshot.resources.length && previous ? { enabled: previous.enabled, resources: previous.resources, issues: previous.issues } : {}),
      revision: revision.value,
    };
    this.catalogSnapshots.set(gameName, result);
    return result;
  }

  private async getCatalogIndex(gameName: string) {
    if (this.catalogSuspensions.get(gameName)) return undefined;
    // Keep snapshot requests responsive, but never overlap two workers for one project.
    if (this.catalogClosing.has(gameName)) return undefined;
    const root = UserDataService.getGameRoot();
    if (this.catalogOpening) {
      await this.catalogOpening;
      return this.getCatalogIndex(gameName);
    }
    const existing = this.catalogIndexes.get(gameName);
    if (this.catalogRoot === root && existing) return existing;
    const opening = (async () => {
      if (this.catalogRoot !== undefined && this.catalogRoot !== root) {
        await this.onModuleDestroy();
      }
      this.catalogRoot = root;
      const index = new GltfCatalogWorkerClient(
        root,
        UserDataService.getEngineTemplateRoot(),
        gameName,
        (error) => this.logger.warn(`glTF 资源索引未更新: ${error.message}`),
        (message) => this.logger.log(message),
        () => this.scheduleCatalogChange(gameName),
      );
      this.catalogIndexes.set(gameName, index);
      index.start();
      this.releaseUnusedCatalog(gameName);
      return index;
    })();
    this.catalogOpening = opening;
    try {
      return await opening;
    } finally {
      if (this.catalogOpening === opening) this.catalogOpening = undefined;
    }
  }

  async onModuleDestroy() {
    for (const timer of this.catalogChangeTimers.values()) clearTimeout(timer);
    this.catalogChangeTimers.clear();
    for (const timer of this.catalogIdleTimers.values()) clearTimeout(timer);
    this.catalogIdleTimers.clear();
    await Promise.all([...this.catalogIndexes.values()].map(index => index.close()));
    await Promise.all([...this.catalogClosing.values()]);
    this.catalogIndexes.clear();
    this.catalogSessions.clear();
    this.catalogReads.clear();
    this.catalogSnapshots.clear();
    this.catalogEpochs.clear();
  }

  async getGltfCatalog(gameName: string) {
    this.catalogReads.set(gameName, Date.now());
    const timer = this.catalogIdleTimers.get(gameName);
    if (timer) clearTimeout(timer);
    this.catalogIdleTimers.delete(gameName);
    const index = await this.getCatalogIndex(gameName);
    this.releaseUnusedCatalog(gameName);
    return this.catalogSnapshot(gameName, index);
  }

  updateGltfRuntimes(gameName: string, runtime: Parameters<GltfCatalogWorkerClient['setRuntimes']>[0]) {
    this.catalogIndexes.get(gameName)?.setRuntimes(runtime);
  }

  async prepareGltfExport(gameName: string) {
    if (this.catalogSuspensions.get(gameName)) throw new Error('正在复制工程资源，请稍后重试导出');
    const gameRoot = join(UserDataService.getGameRoot(), gameName);
    if (!await gltfEnabled(gameRoot, UserDataService.getEngineTemplateRoot())) return;
    const runtime = await scanGltfRuntimes(gameRoot);
    this.updateGltfRuntimes(gameName, runtime);
  }

  async notifyFile(path: string) {
    try {
      const normalized = resolve(path);
      const rel = relative(UserDataService.getGameRoot(), normalized);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return;
      const [gameName, ...segments] = rel.split(sep);
      const inner = segments.join('/');
      if (
        !gameName ||
        !(
          inner === 'webgal-engine.json' ||
          inner === 'game/3d/motion' ||
          inner.startsWith('game/3d/motion/') ||
          inner === 'game/3d/mtn_exp' ||
          inner.startsWith('game/3d/mtn_exp/')
        )
      )
        return;
      if (this.catalogRoot !== UserDataService.getGameRoot()) return;
      const index = this.catalogIndexes.get(gameName);
      if (!index) return;
      index.notify(normalized);
    } catch (error) {
      this.logger.warn(`glTF 资源清单未更新: ${String(error)}`);
    }
  }

  async withPausedIndex<T>(target: string, operation: () => Promise<T>): Promise<T> {
    const path = resolve(target);
    const root = UserDataService.getGameRoot();
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return operation();
    const inner = rel.split(sep).slice(1).join('/');
    if (inner && !['game', 'game/3d', 'game/3d/motion', 'game/3d/mtn_exp'].includes(inner) &&
        !inner.startsWith('game/3d/motion/') && !inner.startsWith('game/3d/mtn_exp/')) return operation();
    const names = rel ? [rel.split(sep)[0]] : [...new Set([...this.catalogIndexes.keys(), ...this.catalogSessions.keys()])];
    for (const name of names) {
      this.catalogSuspensions.set(name, (this.catalogSuspensions.get(name) ?? 0) + 1);
      this.scheduleCatalogChange(name);
    }
    try {
      await Promise.all(names.map(async name => {
        const index = this.catalogIndexes.get(name);
        if (index) {
          this.catalogSnapshots.set(name, this.catalogSnapshot(name, index));
          this.catalogIndexes.delete(name);
          await this.closeCatalog(name, index);
        }
        else if (this.catalogClosing.has(name)) await this.catalogClosing.get(name);
      }));
      return await operation();
    } finally {
      for (const name of names) {
        const count = (this.catalogSuspensions.get(name) ?? 1) - 1;
        if (count) this.catalogSuspensions.set(name, count);
        else {
          this.catalogSuspensions.delete(name);
          if (this.catalogSessions.get(name)?.size) await this.getCatalogIndex(name);
          this.scheduleCatalogChange(name);
        }
      }
    }
  }

}
