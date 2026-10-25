import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as sass from 'sass';
import { chromium } from 'playwright';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), styles=[];
const bundle=await build({absWorkingDir:root,bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.svg':'dataurl'},
  stdin:{resolveDir:root,loader:'tsx',contents:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {FluentProvider,webLightTheme,Button} from '@fluentui/react-components';
    import Picker from './src/components/gltf/GltfFigurePicker';
    import ChooseFile from './src/pages/editor/ChooseFile/ChooseFile';
    window.selected=[];
    function App(){const [value,setValue]=useState('选择立绘文件'),[key,setKey]=useState(0);
      window.configure=(next)=>{window.selected=[];setValue(next);setKey(k=>k+1)};
      return <FluentProvider theme={webLightTheme}><div style={{padding:40}}>
        <Picker key={key} value={value} enabled placeholder="选择立绘文件" onChange={path=>{window.selected.push(path);setValue(path)}}/>
        <ChooseFile title="普通资源" button={<Button>普通资源</Button>} basePath={['figure']}
          onChange={()=>new Promise(resolve=>window.releaseLegacy=resolve)}/>
        <div id="outside" style={{marginTop:650}}>outside</div>
      </div></FluentProvider>;
    }
    fetch('/fixtures').then(r=>r.json()).then(data=>{window.fixtures=data;createRoot(document.getElementById('root')).render(<App/>)});
  `},plugins:[{name:'fixture',setup(builder){
    builder.onResolve({filter:/^@\/components\/Assets\/Assets$/},()=>({path:'assets',namespace:'fixture'}));
    builder.onResolve({filter:/^@\/store\/useEditorStore$/},()=>({path:'store',namespace:'fixture'}));
    builder.onResolve({filter:/^@lingui\/macro$/},()=>({path:'lingui',namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'tsx',resolveDir:root,contents:args.path==='assets'?`
      import React from 'react';
      import FileElement from './src/components/Assets/FileElement';
      import useModelAssets from './src/hooks/gltf/useModelAssets';
      export default function Assets({rootPath,basePath,fileFunction}){
        const {models,loadPreview}=useModelAssets(rootPath,[...rootPath,...basePath]);
        return <div data-testid="browser" style={{width:'100%',overflow:'auto'}}>{Object.keys(window.fixtures).map(name=>{
          const file={name,path:basePath.join('/')+'/'+name,extName:'',isDir:true};
          return <div key={name} data-testid={'row-'+name} style={{padding:8}}>
            <FileElement rootPath={rootPath} file={file} type="list" model={models.get(file.path)} loadModelPreview={loadPreview}
              isProtected handleOpenFile={()=>fileFunction.open(file,'asset')} checkHasFile={()=>false}/>
            <button data-testid={'pick-'+name} onClick={()=>fileFunction.open(file,'asset')}>选取 {name}</button>
          </div>;
        })}</div>;
      }
    `:args.path==='store'?`export default {use:new Proxy({}, {get:(_,key)=>()=>key==='subPage'?'demo':()=>{}})};`
      :`export const t=(strings,...values)=>strings.reduce((text,part,index)=>text+part+(values[index]??''),'');`}));
    builder.onResolve({filter:/^@\//},args=>{const p=resolve(root,'src',args.path.slice(2));return {path:['.ts','.tsx'].map(ext=>p+ext).find(existsSync)??p};});
    builder.onLoad({filter:/\.scss$/},async args=>{
      let css=sass.compileString(await readFile(args.path,'utf8')).css;
      const prefix=basename(args.path).replace(/\W/g,'_'),classes=[...new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(m=>m[1]))];
      for(const name of classes)css=css.replaceAll(new RegExp(`\\.${name}(?![\\w-])`,'g'),`.${prefix}_${name}`);
      styles.push(css);return {loader:'js',contents:`export default ${JSON.stringify(Object.fromEntries(classes.map(name=>[name,`${prefix}_${name}`])))};`};
    });
  }}]});
let fixtures={},requests=[];
function choose(path,role){
  const paths=path.split('config.json+').map((p,i,a)=>i<a.length-1?p+'config.json':p);
  if(paths.length===2){const h=choose(paths[0],'head'),b=choose(paths[1],'body');
    if(h.group!==b.group)throw Error('模型分组不兼容');return {...b,role:'composed',selectionParts:[...h.selectionParts,...b.selectionParts]};}
  const name=path.replace(/\/config\.json$/,''),parts=fixtures[name]?.components??[];
  if(!parts.length)throw Error('不存在的模型');
  if(parts.filter(p=>p.role==='head').length>1)throw Error('多个头部或多个身体');
  const selected=parts[0].role==='integrated'?parts:role?parts.filter(p=>p.role===role):parts;
  if(!selected.length)throw Error(role==='head'?'所选模型包只包含身体':'所选模型包只包含头部');
  return {...selected.at(-1),role:selected.length===2?'composed':selected[0].role,selectionParts:selected};
}
const server=createServer(async(req,res)=>{
  const json=value=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));};
  if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].text);}
  if(req.url==='/fixtures')return json(fixtures);
  if(req.method==='POST'){
    let text='';for await(const chunk of req)text+=chunk;
    const data=JSON.parse(text);requests.push({url:req.url,...data});
    try{
      if(req.url.endsWith('selectGltfModel'))return json(choose(data.path,data.role));
      if(req.url.endsWith('browseGltfModels'))return json({enabled:true,models:Object.entries(fixtures).flatMap(([path])=>{
            try{const selected=choose(path,data.role);return [{...selected,path}];}
            catch{try{return [{...choose(path),preview:undefined,path}];}catch{return [];}}
      })});
    }catch(error){res.statusCode=400;return json({message:error.message});}
  }
  const name=decodeURIComponent(req.url).match(/\/3d\/figure\/([^/]+)\/config\.json$/)?.[1];
  if(name)return json(fixtures[name]);
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<html><head><style>${styles.join('\n')}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const images=await page.evaluate(()=>['#0fa3b1','#f7a541','#9055a2','#538d22'].map((color,index)=>{
    const c=document.createElement('canvas');c.width=200;c.height=180;const x=c.getContext('2d');
    x.fillStyle=color;x.fillRect(25,15,150,140);x.fillStyle='white';x.font='bold 24px sans-serif';x.fillText(index%2?'BODY':'HEAD',55,90);return c.toDataURL('image/webp');
  }));
  const component=(role,name,preview)=>({type:'model',role,name,model:role+'.glb',group:'garupa',renderProfile:'garupa-menu',preview});
  fixtures={pairA:{components:[component('head','A头',images[0]),component('body','A身体',images[1])]},
    pairB:{components:[component('head','B头',images[2]),component('body','B身体',images[3])]},
    headOnly:{components:[component('head','仅头',images[0])]},bodyOnly:{components:[component('body','仅身体',images[3])]},
    integrated:{components:[component('integrated','完整模型',images[1])]},bad:{components:[component('head','重复1'),component('head','重复2')]}};
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const button=name=>page.getByRole('button',{name,exact:true}).and(page.locator('button'));
  const open=async()=>{await button('选择').click();await page.getByTestId('browser').waitFor();};
  const pick=async name=>{await page.getByTestId('pick-'+name).click();await page.getByRole('status').filter({hasText:'正在读取模型'}).waitFor({state:'hidden'});};
  const reset=async value=>{await page.evaluate(v=>window.configure(v),value);await button('选择').waitFor();};
  await open();await button('3D').click();await pick('pairA');
  await button('确定').waitFor();assert.equal(await button('确定').isEnabled(),true);
  assert.equal(await button('选择头部').locator('img').getAttribute('src'),images[0]);
  assert.equal(await button('选择身体').locator('img').getAttribute('src'),images[1]);
  assert.deepEqual(await page.evaluate(()=>window.selected),[]);
  await button('选择身体').click();
  await page.getByTestId('row-pairB').getByText('pairB',{exact:true}).hover();
  await page.waitForFunction(src=>[...document.querySelectorAll('[role="tooltip"] img')].some(img=>img.src===src),images[3]);
  await pick('headOnly');await page.getByRole('alert').filter({hasText:'只包含头部'}).waitFor();
  assert.equal(await button('选择身体').locator('img').getAttribute('src'),images[1]);
  await pick('pairB');await page.waitForFunction(src=>document.querySelector('[aria-label="选择身体"] img')?.src===src,images[3]);
  await button('确定').click();await page.waitForFunction(()=>window.selected.length===1);
  assert.deepEqual(await page.evaluate(()=>window.selected),['pairA/config.json+pairB/config.json']);
  await open();await button('确定').waitFor();assert.equal(await button('确定').isEnabled(),true);
  assert.equal(await button('选择头部').locator('img').getAttribute('src'),images[0]);
  assert.equal(await button('选择身体').locator('img').getAttribute('src'),images[3]);
  await button('取消').last().click();
  await reset('选择立绘文件');await open();await pick('bodyOnly');await button('确定').waitFor();
  assert.equal(await button('确定').isDisabled(),true);assert.equal(await button('选择头部').locator('img').count(),0);
  await button('选择头部').click();await pick('headOnly');assert.equal(await button('确定').isEnabled(),true);
  await button('取消').last().click();assert.deepEqual(await page.evaluate(()=>window.selected),[]);
  await open();await pick('headOnly');await button('确定').waitFor();assert.equal(await button('确定').isDisabled(),true);
  await pick('integrated');await page.waitForFunction(()=>window.selected.length===1);
  assert.deepEqual(await page.evaluate(()=>window.selected),['integrated/config.json']);
  await reset('选择立绘文件');await open();await pick('bad');await page.getByRole('alert').filter({hasText:'多个头部'}).waitFor();
  await page.locator('#outside').click();
  await button('普通资源').click();await pick('integrated');
  await page.waitForFunction(()=>!document.querySelector('[data-testid="browser"]'));
  await page.evaluate(()=>window.releaseLegacy());
  await reset('选择立绘文件');await open();await pick('pairA');await button('确定').click();
  await page.waitForFunction(()=>window.selected.length===1);
  assert.deepEqual(await page.evaluate(()=>window.selected),['pairA/config.json'],'same-package composition retains one config path');
  await open();await button('确定').waitFor();await page.getByRole('status').filter({hasText:'正在读取模型'}).waitFor({state:'hidden'});
  assert.equal(await button('选择头部').getAttribute('aria-pressed'),'true','an existing composition opens on its head');
  await pick('pairB');
  assert.equal(await button('选择头部').locator('img').getAttribute('src'),images[2]);
  assert.equal(await button('选择身体').locator('img').getAttribute('src'),images[3],'a paired body follows a changed head');
  await pick('bodyOnly');await page.getByRole('alert').filter({hasText:'所选模型包只包含身体'}).waitFor();
  assert.equal(await button('选择头部').locator('img').getAttribute('src'),images[2]);
  assert.equal(await button('选择身体').locator('img').getAttribute('src'),images[3]);
  await button('选择身体').click();await pick('pairA');
  await button('选择头部').click();await pick('headOnly');
  assert.equal(await button('选择身体').locator('img').getAttribute('src'),images[1],'a separately selected body stays unchanged');
  await pick('pairA');await pick('headOnly');
  assert.equal(await button('选择身体').locator('img').count(),0,'a paired body clears when the new head package has no body');
  assert.equal(await button('确定').isDisabled(),true);
  await button('取消').last().click();
  assert.deepEqual(errors,[]);
  assert.ok(requests.some(r=>r.url.endsWith('browseGltfModels')&&r.role==='body'));
  await reset('pairA/config.json+pairB/config.json');await open();await button('确定').waitFor();
  await mkdir(resolve(root,'../../.tmp/head-body-picker'),{recursive:true});
  await page.waitForTimeout(350);
  await page.screenshot({path:resolve(root,'../../.tmp/head-body-picker/picker.png')});
  await button('取消').last().click();
  await reset('选择立绘文件');
  let releaseRequest,entered;
  const requestGate=new Promise(r=>releaseRequest=r),requestEntered=new Promise(r=>entered=r);
  const delaySelect=async route=>{entered();await requestGate;await route.continue();};
  await page.route('**/api/manageGame/selectGltfModel',delaySelect);
  await open();await page.getByTestId('pick-headOnly').click();await requestEntered;
  await page.locator('#outside').click();const selectedResponse=page.waitForResponse('**/api/manageGame/selectGltfModel');
  releaseRequest();await selectedResponse;await page.unroute('**/api/manageGame/selectGltfModel',delaySelect);
  await page.waitForTimeout(150);assert.deepEqual(await page.evaluate(()=>window.selected),[],'a cancelled request cannot commit a late response');
  await reset('pairA/config.json+pairB/config.json');
  let releaseRead,readEntered;
  const readGate=new Promise(r=>releaseRead=r),readStarted=new Promise(r=>readEntered=r);
  const delayRead=async route=>{readEntered();await readGate;await route.continue();};
  await page.route('**/game/3d/figure/pairA/config.json',delayRead);
  await open();await readStarted;await page.getByTestId('pick-headOnly').click();
  const readResponse=page.waitForResponse('**/game/3d/figure/pairA/config.json');
  releaseRead();await readResponse;await page.unroute('**/game/3d/figure/pairA/config.json',delayRead);
  await button('确定').waitFor();await page.getByRole('status').filter({hasText:'正在读取模型'}).waitFor({state:'hidden'});
  assert.equal(await button('选择身体').locator('img').getAttribute('src'),images[3],'initialization retains the previous body when a file is clicked before reads complete');
  for (const [width,height] of [[1280,900],[1024,720],[900,600],[800,500]]) {
    await page.setViewportSize({width,height});await page.waitForTimeout(300);
    const popup=await page.locator('.fui-PopoverSurface').boundingBox();
    const confirm=await button('确定').boundingBox();
    assert.ok(popup.height<=500,`composition popup should fit its two cards: ${JSON.stringify(popup)}`);
    assert.ok(confirm.y>=0 && confirm.y+confirm.height<=height,`confirmation is outside ${width}x${height}: ${JSON.stringify(confirm)}`);
    if(height>=600) for(const label of ['选择头部','选择身体']) {
      const card=await button(label).boundingBox();
      assert.ok(card.y>=popup.y && card.y+card.height<=confirm.y,`both cards must fit above confirmation: ${label}`);
    }
  }
  console.log('Figure composition: draft defaults, independent previews/hover, wrong role, confirmation, reopen, cancel, integrated, duplicates and legacy close passed.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
