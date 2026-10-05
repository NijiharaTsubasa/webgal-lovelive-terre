import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigFromFile } from 'vite';
import chokidar from 'chokidar';

test('dev watcher skips locked build output while preserving source watching', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terre-vite-watch-'));
  const locked = path.join(root, 'dist/monaco-iframe/min/vs/editor/editor.main.js');
  const source = path.join(root, 'src/main.js');
  fs.mkdirSync(path.dirname(locked), { recursive: true });
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(locked, 'export default 1;');
  fs.writeFileSync(source, 'export default 2;');
  const config = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.resolve('vite.config.ts'));
  const originalWatch = fs.watch;
  const watched = [], errors = [];
  let watcher;
  fs.watch = (file, ...args) => {
    const absolute = path.resolve(String(file));
    watched.push(absolute);
    if (absolute === locked) throw Object.assign(new Error(`EBUSY: resource busy or locked, watch '${locked}'`), { code: 'EBUSY' });
    return originalWatch(file, ...args);
  };
  try {
    watcher = chokidar.watch(root, { ignoreInitial: true, disableGlobbing: true, ...config.config.server?.watch });
    watcher.on('error', error => errors.push(error));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Watcher did not become ready')), 5000);
      watcher.once('ready', () => { clearTimeout(timer); resolve(); });
      watcher.once('error', () => { clearTimeout(timer); resolve(); });
    });
    assert.deepEqual(errors.map(error => error.code), [], 'locked dist output must not raise EBUSY');
    assert.ok(!watched.includes(locked), 'dist files must never reach fs.watch');
    assert.ok(watched.includes(source), 'source files must retain live watching');
  } finally {
    await watcher?.close();
    fs.watch = originalWatch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
