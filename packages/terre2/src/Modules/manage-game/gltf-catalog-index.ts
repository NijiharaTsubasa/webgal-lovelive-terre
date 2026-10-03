import { watch, FSWatcher } from 'chokidar';
import * as fs from 'fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'path';
import {
  CatalogChangedError,
  CatalogInventory,
  generateGltfResourceCatalog,
  invalidateCatalogFile,
} from './gltf-resource-catalog';

interface GameIndex {
  inventory: CatalogInventory;
  dirty: boolean;
  revision: number;
  result?: Awaited<ReturnType<typeof generateGltfResourceCatalog>>;
  error?: Error;
  operation?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  settlingUntil?: number;
  observed: Map<string, string>;
}

interface WatchRecovery {
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
  operation?: Promise<void>;
  previous: Awaited<ReturnType<typeof generateGltfResourceCatalog>>['resources'];
}

/** Owns filesystem discovery; catalog readers never walk the figure tree. */
export class GltfCatalogIndex {
  private watcher?: FSWatcher;
  private starting?: Promise<void>;
  private games = new Map<string, GameIndex>();
  private ready = false;
  private closed = false;
  private watchError?: Error;
  private recoveries = new Map<string, WatchRecovery>();

  constructor(
    private readonly root: string,
    private readonly engineRoot: string,
    private readonly report: (error: Error) => void = () => {},
    private readonly gameName: string,
  ) {}

  private locate(path: string) {
    const rel = relative(this.root, resolve(path));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return;
    const [game, ...parts] = rel.split(sep);
    if (!game || game !== this.gameName) return;
    return { game, inner: parts.join('/') };
  }

  private relevant(inner: string) {
    return (
      inner === 'index.html' ||
      inner === 'webgal-engine.json' ||
      (inner.startsWith('game/figure/') &&
        (basename(inner) === 'config.json' ||
          /\.(?:mtn|glb)$/.test(inner) ||
          inner.endsWith('.exp.json')))
    );
  }

  private recoveryDirectory(path: string) {
    const location = this.locate(path);
    return location && this.relevant(location.inner) ? dirname(path) : path;
  }

  private recovering(path: string) {
    return [...this.recoveries.keys()].some(target =>
      path === target || path.startsWith(`${this.recoveryDirectory(target)}${sep}`),
    );
  }

  private state(game: string) {
    let state = this.games.get(game);
    if (!state) {
      state = {
        inventory: { files: new Set() },
        dirty: true,
        revision: 0,
        observed: new Map(),
      };
      this.games.set(game, state);
    }
    return state;
  }

  start() {
    if (this.closed) throw new Error('glTF resource index is closed');
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((done, reject) => {
      this.watcher = watch(join(this.root, this.gameName), {
        followSymlinks: false,
        usePolling: false,
        atomic: true,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
        ignored: (path, stat) => {
          if (stat?.isSymbolicLink()) return true;
          const location = this.locate(path);
          if (!location) return false;
          const inner = location.inner;
          // Keep directory ancestors, but exclude scenes, textures and engine assets.
          if (
            inner &&
            inner !== 'game' &&
            inner !== 'game/figure' &&
            !inner.startsWith('game/figure/') &&
            inner !== 'index.html' &&
            inner !== 'webgal-engine.json'
          )
            return true;
          return Boolean(stat?.isFile() && !this.relevant(inner));
        },
      });
      this.watcher.on('all', (event, path, stat) =>
        this.record(event, resolve(path), stat),
      );
      // Raw notifications arrive before awaitWriteFinish publishes stable files.
      // List readers wait for that short settling window, without polling files.
      this.watcher.on('raw', (_event, path, details) => {
        const watchedPath = (details as { watchedPath?: string })?.watchedPath;
        if (!this.ready || typeof watchedPath !== 'string') return;
        const watched = resolve(watchedPath);
        const candidate =
          !path || basename(watched) === basename(path)
            ? watched
            : resolve(watched, path);
        const location = this.locate(candidate);
        if (this.recovering(candidate)) return;
        if (
          location &&
          (this.relevant(location.inner) ||
            (location.inner.startsWith('game/figure/') &&
              !extname(location.inner)))
        ) {
          this.state(location.game).settlingUntil = Date.now() + 250;
        }
      });
      this.watcher.on('error', (error: Error) => {
        if (this.closed) return;
        if (this.retryBusyWatch(error)) return;
        this.watchError = error;
        this.report(error);
        if (!this.ready) reject(error);
      });
      this.watcher.once('ready', () => {
        this.ready = true;
        // Serial game initialization bounds open files across many projects.
        void (async () => {
          for (const [game, state] of this.games) {
            try {
              await this.flush(game, state);
            } catch (error) {
              this.report(error);
            }
          }
        })().then(done, reject);
      });
    });
    return this.starting;
  }

  private retryBusyWatch(error: NodeJS.ErrnoException) {
    if (error.code !== 'EBUSY' || typeof error.path !== 'string') return false;
    const path = resolve(error.path);
    const location = this.locate(path);
    if (!location || (!this.relevant(location.inner) && location.inner !== 'game/figure' && !location.inner.startsWith('game/figure/'))) return false;
    const existing = this.recoveries.get(path);
    const recovery = existing ?? { attempts: 0, previous: this.state(location.game).result?.resources ?? [] };
    if (recovery.timer) clearTimeout(recovery.timer);
    if (!existing) this.report(error);
    this.recoveries.set(path, recovery);
    recovery.timer = setTimeout(() => {
      recovery.timer = undefined;
      recovery.operation = this.restoreWatch(path, recovery).catch(failure => {
        if (this.closed || this.retryBusyWatch(failure)) return;
        this.watchError = failure;
        this.report(failure);
        this.recoveries.delete(path);
      }).finally(() => { recovery.operation = undefined; });
    }, Math.min(250 * 2 ** Math.min(recovery.attempts, 3), 2000));
    return true;
  }

  private async restoreWatch(path: string, recovery: WatchRecovery) {
    if (this.closed) return;
    recovery.attempts++;
    let stat;
    try {
      stat = await fs.lstat(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (this.closed) return;
      await this.watcher.unwatch(path);
      if (this.closed) return;
      this.watcher.add(path);
      this.record('unlink', path);
      this.record('unlinkDir', path);
      this.recoveries.delete(path);
      return;
    }
    if (this.closed) return;
    if (stat.isSymbolicLink()) {
      this.recoveries.delete(path);
      return;
    }
    // unwatch removes Chokidar's retained directory entry from the failed add.
    // add then registers native watchers again, only under the failed target.
    await this.watcher.unwatch(path);
    if (this.closed) return;
    this.watcher.add(path);
    this.settleRecoveredWatch(path, recovery, stat);
  }

  private settleRecoveredWatch(path: string, recovery: WatchRecovery, previous: Awaited<ReturnType<typeof fs.lstat>>) {
    // add is asynchronous; another EBUSY replaces this timer with a local retry.
    recovery.timer = setTimeout(() => {
      recovery.timer = undefined;
      recovery.operation = (async () => {
        let current;
        try { current = await fs.lstat(path); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          if (this.closed) return;
          await this.watcher.unwatch(path);
          if (this.closed) return;
          this.watcher.add(path);
          this.record('unlink', path);
          this.record('unlinkDir', path);
          this.recoveries.delete(path);
          return;
        }
        if (this.closed || recovery.timer) return;
        if (current.size !== previous.size || current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs) {
          this.settleRecoveredWatch(path, recovery, current);
          return;
        }
        this.recoveries.delete(path);
        const location = this.locate(path);
        if (!location) return;
        const state = this.games.get(location.game);
        const directory = current.isDirectory() ? path : dirname(path);
        if (current.isFile()) {
          state?.observed.delete(path);
          this.record('change', path, current);
        }
        for (const file of state?.inventory.files ?? []) {
          if (file === path || file.startsWith(`${directory}${sep}`)) {
            state.observed.delete(file);
            this.record('change', file);
          }
        }
      })().catch(error => {
        if (this.closed || this.retryBusyWatch(error)) return;
        this.watchError = error;
        this.report(error);
        this.recoveries.delete(path);
      }).finally(() => { recovery.operation = undefined; });
    }, 250);
  }

  private record(
    event: string,
    path: string,
    stat?: { size: number; mtimeMs: number; ctimeMs: number },
  ) {
    if (this.closed) return;
    const location = this.locate(path);
    if (!location) return;
    const { game, inner } = location;
    if (event === 'unlinkDir' && !inner) {
      const state = this.games.get(game);
      if (state) state.inventory.cancelled = true;
      if (state?.timer) clearTimeout(state.timer);
      this.games.delete(game);
      return;
    }
    if (event === 'addDir' && !inner) this.state(game);
    const directoryRemoved = event === 'unlinkDir';
    if (!directoryRemoved && !this.relevant(inner)) return;
    const state = this.state(game);
    if (directoryRemoved) {
      for (const file of state.inventory.files) {
        if (file.startsWith(`${path}${sep}`)) {
          state.inventory.files.delete(file);
          state.observed.delete(file);
          invalidateCatalogFile(state.inventory, file);
        }
      }
    } else {
      if (event === 'unlink') {
        if (!state.inventory.files.has(path)) return;
        state.inventory.files.delete(path);
        state.observed.delete(path);
      } else {
        const fingerprint =
          stat && `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (fingerprint && state.observed.get(path) === fingerprint) return;
        if (fingerprint) state.observed.set(path, fingerprint);
        state.inventory.files.add(path);
      }
      invalidateCatalogFile(state.inventory, path);
    }
    state.dirty = true;
    if (this.ready) this.schedule(game, state);
  }

  private schedule(game: string, state: GameIndex) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.flush(game, state).catch(this.report);
    }, 120);
  }

  private async flush(game: string, state: GameIndex) {
    if (state.operation) return state.operation;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.operation = (async () => {
      while (state.dirty && !this.closed) {
        state.dirty = false;
        try {
          const result = await generateGltfResourceCatalog(
            join(this.root, game),
            false,
            this.engineRoot,
            state.inventory,
          );
          for (const [path, recovery] of this.recoveries) {
            const location = this.locate(path);
            if (location?.game !== game) continue;
            const directory = this.recoveryDirectory(path);
            const affected = (entry: typeof result.resources[number]) => {
              const config = resolve(this.root, game, 'game', ...entry.config.split('/').map(decodeURIComponent));
              return config.startsWith(`${directory}${sep}`);
            };
            result.resources = [...result.resources.filter(entry => !affected(entry)), ...recovery.previous.filter(affected)];
          }
          result.resources = [...new Map(result.resources.map(entry => [`${entry.type}:${entry.name}`, entry])).values()];
          state.result = result;
          state.revision++;
          state.error = undefined;
        } catch (error) {
          if (error instanceof CatalogChangedError) {
            state.dirty = true;
            await new Promise((done) => setTimeout(done, 50));
            continue;
          }
          state.error = error;
          throw error;
        }
      }
    })();
    try {
      await state.operation;
    } finally {
      state.operation = undefined;
    }
  }

  async get(game: string) {
    await this.start();
    if (this.watchError)
      throw new Error(
        `glTF 文件监听失败，请重建索引: ${this.watchError.message}`,
      );
    const state = this.state(game);
    while (state.settlingUntil > Date.now()) {
      await new Promise((done) =>
        setTimeout(done, state.settlingUntil - Date.now()),
      );
    }
    await this.flush(game, state);
    if (state.error) throw state.error;
    return { ...state.result, revision: state.revision };
  }

  /** Writes made through Terre are known immediately, without waiting for OS events. */
  async notify(path: string) {
    await this.start();
    const location = this.locate(path);
    if (!location) return;
    if (
      !this.relevant(location.inner) &&
      location.inner &&
      location.inner !== 'game/figure' &&
      !location.inner.startsWith('game/figure/')
    )
      return;
    let stat;
    try {
      stat = await fs.lstat(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.record('unlink', path);
      this.record('unlinkDir', path);
      return this.get(location.game);
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      const walk = async (directory: string) => {
        for (const file of await fs.readdir(directory, {
          withFileTypes: true,
        })) {
          const child = join(directory, file.name);
          if (file.isDirectory()) await walk(child);
          else if (file.isFile()) this.record('change', child);
        }
      };
      await walk(path);
    } else this.record('change', path, stat);
    return this.get(location.game);
  }

  async close() {
    this.closed = true;
    for (const recovery of this.recoveries.values()) {
      if (recovery.timer) clearTimeout(recovery.timer);
    }
    for (const state of this.games.values()) {
      state.inventory.cancelled = true;
      if (state.timer) clearTimeout(state.timer);
    }
    await this.watcher?.close();
    await Promise.allSettled(
      [...this.games.values()].map((state) => state.operation).concat([...this.recoveries.values()].map(recovery => recovery.operation)),
    );
    this.games.clear();
    this.recoveries.clear();
  }
}
