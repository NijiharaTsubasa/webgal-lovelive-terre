import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

test('catalog push keeps idle requests at zero, merges pending changes and recovers after reconnect', {timeout:30000}, async t=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const bundle=await build({absWorkingDir:root,bundle:true,write:false,format:'iife',jsx:'automatic',stdin:{resolveDir:root,loader:'tsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import useGltfCatalog,{useGltfCatalogSession} from './src/hooks/gltf/useGltfCatalog';
 function App(){useGltfCatalogSession('demo');const {catalog}=useGltfCatalog('demo');return <div id="snapshot">{JSON.stringify(catalog)}</div>}
 createRoot(document.getElementById('root')).render(<App/>);`},plugins:[{name:'alias',setup(b){b.onResolve({filter:/^@\//},a=>({path:resolve(root,'src',a.path.slice(2)+'.ts')}))}}]});
 let snapshot={enabled:true,revision:1,indexing:false,resources:[]},requests=0,connections=0,hold,blockNext=false;
 const streams=new Set();
 const notify=()=>{const {resources,...status}=snapshot;for(const s of streams)s.write(`event: catalog\ndata: ${JSON.stringify(status)}\n\n`)};
 const server=createServer(async(req,res)=>{
  if(req.url==='/fixture.js'){res.setHeader('Content-Type','application/javascript');return res.end(bundle.outputFiles[0].contents)}
  if(req.url.startsWith('/api/manageGame/gltfCatalogSession')){connections++;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write('retry: 100\n\n');streams.add(res);req.on('close',()=>streams.delete(res));notify();return}
  if(req.url==='/api/manageGame/updateGltfResourceCatalog'){
   requests++;const captured=snapshot;let body='';for await(const part of req)body+=part;
   const send=()=>{const {resources,...status}=captured;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(JSON.parse(body).revision===captured.revision?{...status,unchanged:true}:captured))};
   if(blockNext){blockNext=false;hold=send;return}return send();
  }
  res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script src="/fixture.js"></script>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{for(const s of streams)s.end();server.closeAllConnections();return new Promise(r=>server.close(r))});
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});t.after(()=>browser.close());
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 const until=async accept=>{const deadline=Date.now()+5000;while(!await accept()){if(Date.now()>deadline)throw Error('Catalog update missing');await page.waitForTimeout(20)}};
 const current=async()=>JSON.parse(await page.locator('#snapshot').textContent());
 await until(async()=>streams.size===1&&(await current()).revision===1);await page.waitForTimeout(150);
 const idle=requests;for(const s of streams)s.write('event: heartbeat\ndata: {"active":true}\n\n');await page.waitForTimeout(5500);
 assert.equal(requests,idle,'idle and heartbeat must not issue catalog requests');
 blockNext=true;snapshot={...snapshot,revision:2,indexing:true,resources:[{name:'first'}]};notify();await until(()=>Boolean(hold));
 snapshot={...snapshot,revision:3,indexing:false,resources:[{name:'latest'}]};for(let i=0;i<20;i++)notify();await page.waitForTimeout(100);
 const pending=requests;hold();hold=undefined;await until(async()=>(await current()).resources.some(x=>x.name==='latest'));
 assert.equal(requests,pending+1,'pending changes must produce only one follow-up read');
 const stable=requests;notify();await page.waitForTimeout(150);assert.equal(requests,stable,'duplicate state must not trigger reads');
 blockNext=true;snapshot={...snapshot,indexing:true};notify();await until(()=>Boolean(hold));
 snapshot={...snapshot,indexing:false};notify();await page.waitForTimeout(100);
 const statusPending=requests;hold();hold=undefined;
 await until(()=>requests===statusPending+1);await until(async()=>!(await current()).indexing);
 for(const s of streams)s.end();snapshot={...snapshot,revision:4,resources:[]};await until(async()=>connections>=2&&(await current()).revision===4);
 await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await until(()=>streams.size===0);
 await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));await until(()=>streams.size===1);
 assert.deepEqual(errors,[]);
});
