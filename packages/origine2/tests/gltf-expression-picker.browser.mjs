import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as sass from 'sass';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const styles = [];
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, format: 'iife', jsx: 'automatic',
  stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {FluentProvider, webLightTheme} from '@fluentui/react-components';
    import Picker from './src/components/gltf/GltfExpressionPicker';
    const base = {native:{eyes:['Sad/左','Open'],mouths:['Smile','A'],defaults:{eye:'Open',closed:'Smile',open:'A'}},
      supportsLive2D:true,live2d:['anon/sad01'],value:''};
    window.selected=[];
    function App(){
      const [props,setProps]=useState(base);
      const [instance,setInstance]=useState(0);
      window.configure=(overrides)=>{window.selected=[];setProps({...base,...overrides});setInstance(value=>value+1);};
      return <FluentProvider theme={webLightTheme}><div style={{padding:40,width:420}}>
        <Picker key={instance} {...props} onValueChange={value=>{window.selected.push(value);setProps(previous=>({...previous,value}));}} />
        <div id="outside" style={{marginTop:450}}>outside</div>
      </div></FluentProvider>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  ` },
  plugins: [{ name: 'fixture-styles-and-store', setup(builder) {
    builder.onResolve({ filter: /^@\/store\/useEditorStore$/ }, () => ({ path: 'store', namespace: 'fixture' }));
    builder.onResolve({ filter: /^@lingui\/macro$/ }, () => ({ path: 'lingui', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'store'
      ? `export default {use:new Proxy({}, {get:(_,key)=>()=>key==='cascaderDelimiters'?['/']:key==='isCascaderDelimitersCustomizable'?false:()=>{}})};`
      : `export const t=(strings,...values)=>strings.reduce((text,part,index)=>text+part+(values[index]??''),'');` }));
    builder.onResolve({ filter: /^@\// }, args => {
      const path = resolve(root, 'src', args.path.slice(2));
      return { path: ['.ts', '.tsx'].map(extension => path + extension).find(existsSync) ?? path };
    });
    builder.onLoad({ filter: /\.scss$/ }, async args => {
      let css = sass.compileString(await readFile(args.path, 'utf8')).css;
      const prefix = basename(args.path).replace(/\W/g, '_');
      const classes = [...new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(match => match[1]))];
      for (const name of classes) css = css.replaceAll(new RegExp(`\\.${name}(?![\\w-])`, 'g'), `.${prefix}_${name}`);
      styles.push(css);
      return { loader: 'js', contents: `export default ${JSON.stringify(Object.fromEntries(classes.map(name => [name, `${prefix}_${name}`])))};` };
    });
  } }],
});
const javascript = bundle.outputFiles[0].text;
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(javascript); }
  else response.end(`<html><head><style>${styles.join('\n')}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: '选择表情', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Live2D', exact: true }).count(), 1);
  assert.equal(await page.getByRole('combobox').count(), 1, 'unselected supported model opens Live2D');
  await page.getByRole('button', { name: '3D', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.selected), []);
  await page.getByRole('button', { name: 'Sad/左', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.selected), []);
  await page.getByRole('button', { name: 'Smile', exact: true }).first().click();
  assert.deepEqual(await page.evaluate(() => window.selected), []);
  assert.equal(await page.getByRole('button', { name: 'A', exact: true }).last().isEnabled(), true);
  await page.getByRole('textbox', { name: '搜索3D张口' }).fill('a');
  assert.equal(await page.getByRole('button', { name: 'Smile', exact: true }).count(), 1, 'only the open-mouth column is filtered');
  if (process.env.GLTF_PICKER_SCREENSHOTS) {
    await mkdir(process.env.GLTF_PICKER_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: resolve(process.env.GLTF_PICKER_SCREENSHOTS, 'native-three-columns.png') });
  }
  await page.getByRole('button', { name: 'A', exact: true }).last().click();
  assert.deepEqual(await page.evaluate(() => window.selected), ['3d:Sad%2F%E5%B7%A6/Smile/A']);
  await page.getByRole('button', { name: 'Sad/左 / Smile / A', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Live2D', exact: true }).count(), 1);
  assert.equal(await page.getByRole('textbox', { name: '搜索3D张口' }).inputValue(), '', 'reopening resets search');
  assert.equal(await page.getByRole('button', { name: 'A', exact: true }).last().isEnabled(), true, 'saved selection reopens all three levels');
  await page.locator('#outside').click();
  await page.evaluate(() => window.configure({}));
  await page.getByRole('button', { name: '选择表情', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '搜索3D眼型' }).count(), 1, 'a new empty picker remembers native mode');
  await page.locator('#outside').click();
  await page.evaluate(() => window.configure({ value: 'anon/sad01' }));
  await page.getByRole('button', { name: 'anon/sad01', exact: true }).click();
  assert.equal(await page.getByRole('combobox').count(), 1, 'saved Live2D value overrides remembered native mode');
  await page.getByRole('button', { name: 'Live2D', exact: true }).click();
  await page.locator('#outside').click();
  await page.evaluate(() => window.configure({ live2d: [] }));
  await page.getByRole('button', { name: '选择表情', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '搜索3D眼型' }).count(), 1, 'empty Live2D defaults to native');
  await page.locator('#outside').click();
  await page.evaluate(() => window.configure({ supportsLive2D: false, value: '3d:Open/Smile/A' }));
  await page.getByRole('button', { name: 'Open / Smile / A', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Live2D', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '3D', exact: true }).count(), 0);
  assert.equal(await page.getByRole('textbox', { name: '搜索3D眼型' }).count(), 1);
  await page.locator('#outside').click();
  await page.evaluate(() => window.configure({}));
  await page.getByRole('button', { name: '选择表情', exact: true }).click();
  assert.equal(await page.getByRole('combobox').count(), 1, 'capability fallback leaves remembered Live2D mode intact');
  assert.deepEqual(errors, []);
  console.log('Real React/Fluent native expression picker browser checks passed.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
