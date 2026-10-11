import { ConsoleLogger, Injectable, OnModuleDestroy } from '@nestjs/common';
import { isAbsolute, relative, resolve, sep } from 'path';
import { UserDataService } from '../user-data/user-data.service';
import { GltfCatalogWorkerClient } from './gltf-catalog-worker-client';

@Injectable()
export class GltfResourceIndexService implements OnModuleDestroy {
  constructor(private readonly logger: ConsoleLogger) {}

  private catalogIndexes = new Map<string, GltfCatalogWorkerClient>();
  private catalogRoot?: string;
  private catalogOpening?: Promise<GltfCatalogWorkerClient>;
  private catalogSessions = new Map<string, Map<string, number>>();
  private catalogPins = new Map<string, number>();
  private catalogIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private catalogSuspensions = new Map<string, number>();
  private catalogSessionTimer?: ReturnType<typeof setInterval>;
  private catalogEpoch = 0;
  private catalogEpochs = new Map<string, { index: GltfCatalogWorkerClient; revision: number; value: number }>();
  private catalogSnapshots = new Map<string, any>();

  async gltfCatalogSession(gameName: string, sessionId: string, active: boolean) {
    const root = UserDataService.getGameRoot();
    if (this.catalogRoot !== undefined && this.catalogRoot !== root) await this.onModuleDestroy();
    this.catalogRoot = root;
    let sessions = this.catalogSessions.get(gameName);
    if (!sessions) {
      sessions = new Map();
      this.catalogSessions.set(gameName, sessions);
    }
    if (active) {
      sessions.set(sessionId, Date.now() + 30000);
      const timer = this.catalogIdleTimers.get(gameName);
      if (timer) clearTimeout(timer);
      this.catalogIdleTimers.delete(gameName);
      if (!this.catalogSessionTimer) {
        this.catalogSessionTimer = setInterval(() => this.expireCatalogSessions(), 5000);
        this.catalogSessionTimer.unref();
      }
      await this.getCatalogIndex(gameName);
    } else {
      sessions.delete(sessionId);
      this.releaseUnusedCatalog(gameName);
    }
    return { ok: true };
  }

  private expireCatalogSessions() {
    for (const [gameName, sessions] of this.catalogSessions) {
      for (const [id, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(id);
      this.releaseUnusedCatalog(gameName);
    }
  }

  private releaseUnusedCatalog(gameName: string) {
    if (this.catalogSessions.get(gameName)?.size || this.catalogPins.get(gameName) || this.catalogIdleTimers.has(gameName)) return;
    const timer = setTimeout(() => {
      this.catalogIdleTimers.delete(gameName);
      if (this.catalogSessions.get(gameName)?.size || this.catalogPins.get(gameName)) return;
      const index = this.catalogIndexes.get(gameName);
      this.catalogIndexes.delete(gameName);
      this.catalogSessions.delete(gameName);
      if (index) {
        this.catalogSnapshots.set(gameName, this.catalogSnapshot(gameName, index));
        void index.close().catch(error => this.logger.warn(`glTF 索引关闭失败: ${error.message}`));
      }
      if (!this.catalogSessions.size && this.catalogSessionTimer) {
        clearInterval(this.catalogSessionTimer);
        this.catalogSessionTimer = undefined;
      }
    }, 10000);
    timer.unref();
    this.catalogIdleTimers.set(gameName, timer);
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
    if (this.catalogSessionTimer) clearInterval(this.catalogSessionTimer);
    this.catalogSessionTimer = undefined;
    for (const timer of this.catalogIdleTimers.values()) clearTimeout(timer);
    this.catalogIdleTimers.clear();
    await Promise.all([...this.catalogIndexes.values()].map(index => index.close()));
    this.catalogIndexes.clear();
    this.catalogSessions.clear();
    this.catalogPins.clear();
    this.catalogSnapshots.clear();
    this.catalogEpochs.clear();
  }

  async getGltfCatalog(gameName: string) {
    return this.catalogSnapshot(gameName, await this.getCatalogIndex(gameName));
  }

  updateGltfRuntimes(gameName: string, runtime: Parameters<GltfCatalogWorkerClient['setRuntimes']>[0]) {
    this.catalogIndexes.get(gameName)?.setRuntimes(runtime);
  }

  async ensureGltfCatalog(gameName: string) {
    this.catalogPins.set(gameName, (this.catalogPins.get(gameName) ?? 0) + 1);
    const timer = this.catalogIdleTimers.get(gameName);
    if (timer) clearTimeout(timer);
    this.catalogIdleTimers.delete(gameName);
    try {
      const index = await this.getCatalogIndex(gameName);
      if (!index) throw new Error('正在复制工程资源，请稍后重试导出');
      return await index.settled();
    } finally {
      const count = (this.catalogPins.get(gameName) ?? 1) - 1;
      if (count) this.catalogPins.set(gameName, count);
      else this.catalogPins.delete(gameName);
      this.releaseUnusedCatalog(gameName);
    }
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
    for (const name of names) this.catalogSuspensions.set(name, (this.catalogSuspensions.get(name) ?? 0) + 1);
    try {
      await Promise.all(names.map(async name => {
        const index = this.catalogIndexes.get(name);
        if (index) {
          this.catalogSnapshots.set(name, this.catalogSnapshot(name, index));
          this.catalogIndexes.delete(name);
          await index.close();
        }
      }));
      return await operation();
    } finally {
      for (const name of names) {
        const count = (this.catalogSuspensions.get(name) ?? 1) - 1;
        if (count) this.catalogSuspensions.set(name, count);
        else {
          this.catalogSuspensions.delete(name);
          if (this.catalogSessions.get(name)?.size) await this.getCatalogIndex(name);
        }
      }
    }
  }

}
