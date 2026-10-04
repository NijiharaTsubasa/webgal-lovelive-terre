import { Worker } from 'worker_threads';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { GltfCatalogEntry } from './gltf-resource-catalog';

export interface GltfCatalogSnapshot {
  enabled: boolean;
  resources: GltfCatalogEntry[];
  issues: string[];
  revision: number;
  indexing: boolean;
  error?: string;
}

/** A project-local worker owns scanning, parsing and filesystem observation. */
export class GltfCatalogBackground {
  private worker?: Worker;
  private started = false;
  private closed = false;
  private latest: GltfCatalogSnapshot = {
    enabled: true,
    resources: [],
    issues: [],
    revision: -1,
    indexing: true,
  };
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: GltfCatalogSnapshot) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    private readonly root: string,
    private readonly engineRoot: string,
    private readonly gameName: string,
    private readonly report: (error: Error) => void = () => {},
    private readonly reportProgress: (message: string) => void = () => {},
  ) {}

  start() {
    if (this.closed || this.started) return;
    this.started = true;
    try {
      // Standalone emits the bundled worker beside main.js; Nest keeps module paths.
      const bundled = join(__dirname, 'gltf-catalog-worker.js');
      const source = join(__dirname, 'gltf-catalog-worker.ts');
      const path = existsSync(bundled) ? bundled : source;
      const packaged = Boolean((process as any).pkg);
      this.worker = new Worker(packaged ? readFileSync(path, 'utf8') : path, {
        workerData: {
          root: this.root,
          engineRoot: this.engineRoot,
          gameName: this.gameName,
        },
        ...(packaged ? { eval: true } : {}),
        ...(path.endsWith('.ts')
          ? {
              env: {
                ...process.env,
                TS_NODE_PROJECT: join(__dirname, '../../../tsconfig.json'),
              },
              execArgv: [
                '-r',
                createRequire(__filename).resolve(
                  'ts-node/register/transpile-only',
                ),
              ],
            }
          : {}),
      });
      this.worker.on('message', (message) => {
        if (this.closed) return;
        if (message.snapshot) this.latest = message.snapshot;
        if (message.type === 'progress') this.reportProgress(message.message);
        if (message.type === 'warning') this.report(new Error(message.error));
        if (message.type === 'error') this.fail(new Error(message.error));
        if (message.requestId !== undefined) {
          const request = this.pending.get(message.requestId);
          this.pending.delete(message.requestId);
          if (message.error) request?.reject(new Error(message.error));
          else request?.resolve(this.latest);
        }
      });
      this.worker.on('error', (error) => this.fail(error));
      this.worker.on('exit', (code) => {
        if (!this.closed && !this.latest.error)
          this.fail(new Error(`glTF resource index worker exited (${code})`));
      });
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.latest = { ...this.latest, indexing: false, error: error.message };
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.report(error);
  }

  snapshot() {
    this.start();
    return this.latest;
  }

  notify(path: string) {
    this.start();
    if (!this.closed && this.worker && !this.latest.error) {
      this.latest = { ...this.latest, indexing: true };
      try {
        this.worker.postMessage({ type: 'notify', path });
      } catch (error) {
        this.fail(error);
      }
    }
  }

  setRuntimes(runtime: { resources: GltfCatalogEntry[]; issues: string[] }) {
    this.start();
    if (!this.closed && this.worker) this.worker.postMessage({ type: 'runtime', runtime });
  }

  settled(): Promise<GltfCatalogSnapshot> {
    this.start();
    if (this.closed)
      return Promise.reject(new Error('glTF resource index is closed'));
    if (this.latest.error) return Promise.reject(new Error(this.latest.error));
    return new Promise((resolve, reject) => {
      const requestId = ++this.sequence;
      this.pending.set(requestId, { resolve, reject });
      try {
        this.worker.postMessage({ type: 'settled', requestId });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  async close() {
    this.closed = true;
    for (const request of this.pending.values())
      request.reject(new Error('glTF resource index is closed'));
    this.pending.clear();
    await this.worker?.terminate();
    this.worker = undefined;
  }
}
