import { Worker } from 'worker_threads';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { GltfCatalogEntry } from './gltf-resource-types';

export interface GltfCatalogSnapshot {
  enabled: boolean;
  resources: GltfCatalogEntry[];
  issues: string[];
  revision: number;
  indexing: boolean;
  error?: string;
}

/** A project-local worker owns scanning, parsing and filesystem observation. */
export class GltfCatalogWorkerClient {
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
    if (!this.closed && this.worker && !this.latest.error) {
      try {
        this.worker.postMessage({ type: 'runtime', runtime });
      } catch (error) {
        this.fail(error);
      }
    }
  }

  async close() {
    this.closed = true;
    await this.worker?.terminate();
    this.worker = undefined;
  }
}
