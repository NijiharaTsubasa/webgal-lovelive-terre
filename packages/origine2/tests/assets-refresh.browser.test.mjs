import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as sass from 'sass';
import { chromium } from 'playwright';

test('figure browser keeps mounted rows, thumbnails and scroll during catalog updates and head/body selection', { timeout: 60000 }, async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), styles = [];
  const bundle = await build({ absWorkingDir: root, bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.svg': 'dataurl' },
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {FluentProvider,webLightTheme} from '@fluentui/react-components';
      import {useSWRConfig} from 'swr';
      import useGltfCatalog from './src/hooks/gltf/useGltfCatalog';
      import Picker from './src/components/gltf/GltfFigurePicker';
      function App(){const [value,setValue]=useState('pair00/config.json');
        const {catalog}=useGltfCatalog('demo');const {mutate}=useSWRConfig();
        window.poll=()=>mutate(['gltf-catalog','demo']);
        return <FluentProvider theme={webLightTheme}><div style={{padding:30}}>
          <span id="revision">{catalog.revision}</span>
          <Picker value={value} enabled placeholder="选择立绘文件" onChange={setValue}/>
        </div></FluentProvider>;}
      createRoot(document.getElementById('root')).render(<App/>);
    ` }, plugins: [{ name: 'fixtures', setup(builder) {
      const fixtures = {
        '@/store/useEditorStore': `const values={subPage:'demo',viewType:'grid',sortBy:'name',sortOrder:'asc',isTrash:false};export default {use:new Proxy({}, {get:(_,key)=>()=>values[key]??(()=>{})})};`,
        '@/api': `export const api={assetsControllerReadAssets:async path=>({data:await (await fetch('/files?path='+encodeURIComponent(path))).json()})};`,
        '@/hooks/useTrashFailedToast': 'export default ()=>()=>{};',
        '@lingui/macro': `export const t=(strings,...values)=>strings.reduce((s,p,i)=>s+p+(values[i]??''),'');`,
      };
      builder.onResolve({ filter: /^(?:@\/|@lingui\/macro$)/ }, args => {
        if (args.path in fixtures) return { path: args.path, namespace: 'fixture' };
        const p = resolve(root, 'src', args.path.slice(2));
        return { path: ['.ts', '.tsx', ''].map(ext => p + ext).find(existsSync) ?? p };
      });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', contents: fixtures[args.path] }));
      builder.onLoad({ filter: /\.scss$/ }, async args => {
        let css = sass.compileString(await readFile(args.path, 'utf8')).css;
        const prefix = basename(args.path).replace(/\W/g, '_'), names = [...new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(m => m[1]))];
        for (const name of names) css = css.replaceAll(new RegExp(`\\.${name}(?![\\w-])`, 'g'), `.${prefix}_${name}`);
        styles.push(css);
        return { loader: 'js', contents: `export default ${JSON.stringify(Object.fromEntries(names.map(name => [name, `${prefix}_${name}`])))};` };
      });
    } }] });
  let revision = 0, directoryReads = 0, modelReads = 0;
  const names = Array.from({ length: 60 }, (_, i) => `pair${String(i).padStart(2, '0')}`);
  const image = 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=';
  const component = (role, name) => ({ type: 'model', role, name, model: role + '.glb', group: 'garupa', preview: image });
  const parts = name => [component('head', name), component('body', name)];
  const server = createServer(async (req, res) => {
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'application/javascript; charset=utf-8'); return res.end(bundle.outputFiles[0].contents); }
    if (req.url.startsWith('/files?')) { directoryReads++; return json({ dirInfo: names.map(name => ({ name, isDir: true, extName: '' })) }); }
    if (req.url.includes('/config.json')) return json({ components: parts('pair00') });
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      if (req.url.endsWith('updateGltfResourceCatalog')) return json({ enabled: true, indexing: true, revision: ++revision, resources: [] });
      if (req.url.endsWith('browseGltfModels')) { modelReads++; return json({ models: names.map(path => ({ path, name: path, preview: image })) }); }
      if (req.url.endsWith('selectGltfModel')) {
        const name = data.path.split('/')[0];
        return json({ role: 'composed', group: 'garupa', selectionParts: parts(name).filter(p => !data.role || p.role === data.role) });
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<html><head><style>${styles.join('\n')}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => {server.closeAllConnections(); return new Promise(r => server.close(r));});
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(7000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: '选择', exact: true }).and(page.locator('button')).click();
  await page.getByRole('button', { name: '确定', exact: true }).waitFor();
  await page.getByRole('status').waitFor({ state: 'hidden' });
  const row = page.locator('[draggable="true"]').filter({ hasText: 'pair01' });
  await row.locator('img[src^="data:image/webp"]').waitFor();
  await page.evaluate(() => {
    window.savedRow = [...document.querySelectorAll('[draggable="true"]')].find(e => e.textContent === 'pair01');
    window.savedImage = window.savedRow.querySelector('img');
  });
  const reads = [directoryReads, modelReads];
  for (let i = 0; i < 4; i++) await page.evaluate(() => window.poll());
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.savedRow.isConnected), true, 'motion catalog updates must not unmount file rows');
  assert.equal(await page.evaluate(() => window.savedImage.isConnected), true, 'catalog updates must retain loaded thumbnails');
  assert.deepEqual([directoryReads, modelReads], reads, 'motion indexing must not reread model directories');
  await row.click();
  await page.getByRole('status').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.savedRow.isConnected), true, 'selecting a head must not recreate the browser rows');
  await page.getByRole('button', { name: '选择身体', exact: true }).click();
  await row.click();
  await page.getByRole('status').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.savedRow.isConnected), true, 'selecting a body must not recreate the browser rows');
  const scroll = await page.evaluate(() => {
    const outer = window.savedRow.parentElement.parentElement.parentElement;
    outer.scrollTop = 300; window.savedScroll = outer; return outer.scrollTop;
  });
  assert.ok(scroll > 0, 'fixture must have enough models to exercise scrolling');
  await page.waitForTimeout(150);
  await page.evaluate(() => window.poll()); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.savedScroll.scrollTop), scroll, 'index progress must not reset scrolling');
  assert.deepEqual(errors, []);
});
