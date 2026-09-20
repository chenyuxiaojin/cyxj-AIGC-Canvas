// Real modules, isolated storage/IPC: no live app, project, model or media writes.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
const requireWeb=createRequire(new URL('../../web/package.json',import.meta.url));
const ts=requireWeb('typescript');
const {create}=requireWeb('zustand');
const {persist}=requireWeb('zustand/middleware');
let requestSequence=0;
const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
function load(path,imports,globals={}) {
 const source=readFileSync(new URL('../../web/src/'+path,import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 const context=vm.createContext({module,exports:module.exports,console,Blob,URL,ArrayBuffer,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout,structuredClone,...globals});
 context.require=name=>{
  if(name==="../protocol/canvas-operation-protocol") return load("app/(user)/canvas/protocol/canvas-operation-protocol.ts",{});
  assert.ok(name in imports,`Unexpected import ${name}`);
  // Zustand checks instanceof Promise: evaluate it in the source module's realm.
  if(name==='zustand/middleware') return vm.runInContext('(function(){const exports={};'+readFileSync(requireWeb.resolve('zustand/middleware'),'utf8')+';return exports})()',context);
  if(name==='fast-deep-equal') return vm.runInContext('(function(){const module={exports:{}};'+readFileSync(requireWeb.resolve('fast-deep-equal'),'utf8')+';return {default:module.exports}})()',context);
  return imports[name];
 };
 vm.runInContext(js,context);
 return module.exports;
}
const runtime=load('services/desktop-runtime.ts',{'@tauri-apps/api/core':{}});
const canvasPath='app/(user)/canvas/';
const graph=load(canvasPath+'utils/canvas-graph.ts',{});
const original={id:'audit-film',title:'audit',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',nodes:[{id:'n',type:'text',title:'原节点',position:{x:0,y:0},width:240,height:160,metadata:{content:'saved'}}],connections:[],chatSessions:[],viewport:{x:0,y:0,k:1},sidePanel:{open:true,width:320},agentPanel:{open:false,width:390},__desktopRevision:'base'};
async function storeHarness({desktop=true,deleted=[],local=[original],storage,fail=false,database:initialDatabase}={}) {
 const values=storage||new Map([['infinite-canvas:canvas_store',JSON.stringify({state:{projects:local},version:0})]]);
 const database=initialDatabase||new Map([[original.id,structuredClone(original)]]);const writes=[];let failure=fail;let localFailure=false;let beforeSave=async()=>{};let response=value=>value;let beforeRestore=async()=>{};let beforeRead=async()=>{};let beforeLocalWrite=async()=>{};const restores=[];
 const service={...runtime,restoreDesktopCanvasVersion:async(id,sequence,expectedRevision,requestId)=>{ restores.push({id,sequence,expectedRevision,requestId});await beforeRestore();const current=database.get(id);if(current.__desktopRevision!==expectedRevision)throw new runtime.CanvasPersistenceError('REVISION_CONFLICT','REVISION_CONFLICT');const saved={...structuredClone(original),__desktopRevision:'restored-'+sequence};database.set(id,saved);return structuredClone(saved);},isDesktopRuntime:()=>desktop,loadDesktopCanvasDeletedIds:async()=>deleted,loadDesktopCanvasProject:async id=>{await beforeRead(id);if(!database.has(id))throw new runtime.CanvasPersistenceError('NOT_FOUND','not found');return structuredClone(database.get(id))},loadDesktopCanvasProjects:async()=>({projects:[...database.values()].map(p=>structuredClone(p)),failures:[]}),saveDesktopCanvasProject:async project=>{
  writes.push(structuredClone(project));await beforeSave(project);if(failure)throw Error('injected disk failure');
  const current=database.get(project.id);if(current&&current.__desktopRevision!==project.__desktopRevision)throw new runtime.CanvasPersistenceError('REVISION_CONFLICT','REVISION_CONFLICT');
  const saved={...structuredClone(project),__desktopRevision:'revision-'+writes.length};database.set(project.id,saved);return response(structuredClone(saved));
 }};
 const {useCanvasStore:store}=load(canvasPath+'stores/use-canvas-store.ts',{
  zustand:{create},'zustand/middleware':{persist},nanoid:{nanoid:()=> 'recovered-film-'+(++requestSequence)},'fast-deep-equal':{default:requireWeb('fast-deep-equal')},'../utils/canvas-graph':graph,
  '@/lib/localforage-storage':{canvasPersistenceStorage:{keys:async()=>[...values.keys()],getItem:async key=>values.get(key)||null,setItem:async(key,value)=>{await beforeLocalWrite(key,value);if(localFailure)throw Error('injected local storage failure');values.set(key,value)},removeItem:async key=>{values.delete(key)}}},
  '@/services/api/canvas-tasks':{},'@/services/api/user-config':{},'@/stores/use-user-store':{useUserStore:{getState:()=>({token:''})}},'@/services/desktop-runtime':service,
 });
 for(let n=0;n<100&&!store.getState().hydrated;n++)await tick(1);
 assert.equal(store.getState().hydrated,true);
 return {store,values,writes,database,restores,beforeRead:hook=>{beforeRead=hook},beforeLocalWrite:hook=>{beforeLocalWrite=hook},beforeRestore:hook=>{beforeRestore=hook},setFailure:value=>{failure=value},setLocalFailure:value=>{localFailure=value},beforeSave:hook=>{beforeSave=hook},response:hook=>{response=hook}};
}

test('failed desktop save survives refresh and restart, then an explicit retry saves it',async()=>{
 const h=await storeHarness({fail:true});
 h.store.getState().updateProject(original.id,{nodes:[{id:'n',type:'text',title:'原节点',position:{x:0,y:0},width:240,height:160,metadata:{content:'keep my edit'}}]});
 await tick(460);assert.equal(h.store.getState().saveStatus[original.id].state,'error');
 await h.store.getState().refreshFromDesktop();
 assert.equal(h.store.getState().projects[0].nodes[0].metadata.content,'keep my edit');
 const restarted=await storeHarness({storage:h.values,fail:true});
 assert.equal(restarted.store.getState().projects[0].nodes[0].metadata.content,'keep my edit');
 restarted.setFailure(false);await restarted.store.getState().retrySave(original.id);
 assert.equal(restarted.database.get(original.id).nodes[0].metadata.content,'keep my edit');
 assert.equal(restarted.values.has('infinite-canvas:save-journal:'+original.id),false);
});

test('refresh must not rebase pending edits onto another writer without a conflict',async()=>{
 const h=await storeHarness();
 h.store.getState().updateProject(original.id,{title:'my title',nodes:[{id:'n',type:'text',title:'原节点',position:{x:0,y:0},width:240,height:160,metadata:{content:'my edit'}}]});
 h.database.set(original.id,{...original,__desktopRevision:'someone-else',nodes:[{id:'n',type:'text',title:'原节点',position:{x:0,y:0},width:240,height:160,metadata:{content:'other edit'}}]});
 await h.store.getState().refreshFromDesktop();assert.equal(h.store.getState().saveStatus[original.id].state,'conflict');
 assert.equal(h.database.get(original.id).nodes[0].metadata.content,'other edit');
 assert.equal(h.store.getState().projects[0].nodes[0].metadata.content,'my edit');
});

test('deleted desktop projects disappear from active list while original local records are retained',async()=>{
 const gone={...original,id:'deleted-film'};
 const h=await storeHarness({local:[original,gone],deleted:[gone.id]});
 assert.deepEqual(Array.from(h.store.getState().projects,p=>p.id),[original.id]);
 assert.equal(h.writes.length,0);
 assert.equal(JSON.parse(h.values.get('infinite-canvas:recovery:deleted:'+gone.id)).id,gone.id);
});

test('UI-only viewport and panel choices survive without changing content timestamps',async()=>{
 const h=await storeHarness({desktop:false});
 h.store.getState().updateProject(original.id,{viewport:{x:321,y:456,k:.05},sidePanel:{open:false,width:400},agentPanel:{open:true,width:500}});
 await tick(460);
 const restarted=await storeHarness({desktop:false,storage:h.values});const p=restarted.store.getState().projects[0];
 assert.equal(p.viewport.k,.05);assert.equal(p.sidePanel.open,false);assert.equal(p.agentPanel.open,true);assert.equal(p.updatedAt,original.updatedAt);assert.equal(h.writes.length,0);
});

test('an explicit empty project index does not resurrect the legacy whole-store copy',async()=>{
 const values=new Map([['infinite-canvas:canvas_store',JSON.stringify({state:{projects:[original]}})],['infinite-canvas:canvas_store:index',JSON.stringify({version:1,ids:[]})]]);
 const h=await storeHarness({desktop:false,storage:values});assert.equal(h.store.getState().projects.length,0);
});

test('rapid edits during a delayed save use the new revision and persist the final edit',async()=>{
 const h=await storeHarness();let release;const gate=new Promise(resolve=>{release=resolve});
 h.beforeSave(async()=>{if(h.writes.length===1)await gate});
 h.store.getState().updateProject(original.id,{nodes:[{id:'n',type:'text',title:'原节点',position:{x:0,y:0},width:240,height:160,metadata:{content:'first'}}]});
 const saving=h.store.getState().retrySave(original.id);
 for(let i=0;i<100&&!h.writes.length;i++)await tick(1);
 for(let i=0;i<25;i++)h.store.getState().updateProject(original.id,{nodes:[{id:'n',type:'text',title:'原节点',position:{x:0,y:0},width:240,height:160,metadata:{content:'latest '+i}}]});
 assert.equal(h.store.getState().saveStatus[original.id].state,'pending');release();await saving;
 assert.equal(h.database.get(original.id).nodes[0].metadata.content,'latest 24');
 assert.equal(h.store.getState().projects[0].nodes[0].metadata.content,'latest 24');
 assert.equal(h.writes.length,2);assert.equal(h.writes[1].__desktopRevision,'revision-1');assert.equal(h.store.getState().saveStatus[original.id].state,'saved');
});

test('JSON object key order in a real IPC response does not cause a false save conflict',async()=>{
 const h=await storeHarness();
 h.response(project=>{const node=project.nodes[0];project.nodes[0]=Object.fromEntries(Object.entries(node).reverse());return project;});
 h.store.getState().updateProject(original.id,{nodes:[{id:'n',type:'text',title:'原节点',position:{x:0,y:0},width:240,height:160,metadata:{content:'changed'}}],viewport:{k:2,y:20,x:10}});await h.store.getState().retrySave(original.id);
 assert.equal(h.store.getState().saveStatus[original.id].state,'saved');
});

test('browser persistence failures are visible and retry writes the current snapshot',async()=>{
 const h=await storeHarness({desktop:false});h.setLocalFailure(true);
 h.store.getState().updateProject(original.id,{viewport:{x:88,y:99,k:.2}});await tick(460);
 assert.equal(h.store.getState().saveStatus[original.id].state,'error');h.setLocalFailure(false);await h.store.getState().retrySave(original.id);
 assert.equal(JSON.parse(h.values.get('infinite-canvas:canvas_project:'+original.id)).viewport.x,88);
 assert.equal(h.store.getState().saveStatus[original.id].state,'saved');
});

test('invalid graph writes are rejected and retained for repair without touching saved content',async()=>{
 const h=await storeHarness();
 h.store.getState().updateProject(original.id,{connections:[{id:'bad',fromNodeId:'n',toNodeId:'missing'}]});
 await assert.rejects(h.store.getState().retrySave(original.id),/节点不存在/);
 assert.equal(h.database.get(original.id).connections.length,0);assert.equal(h.store.getState().projects[0].connections.length,1);
 assert.throws(()=>h.store.getState().importProject({nodes:[{id:'same'},{id:'same'}],connections:[]}),/重复节点/);
});


test('a committed write with a lost reply is recovered only when every saved field matches',async()=>{
 const h=await storeHarness();h.response(()=>{throw Error('reply lost after commit')});
 h.store.getState().updateProject(original.id,{nodes:[{id:'n',type:'text',title:'原节点',position:{x:0,y:0},width:240,height:160,metadata:{content:'already committed'}}]});
 await assert.rejects(h.store.getState().retrySave(original.id),/reply lost/);
 const restarted=await storeHarness({storage:h.values,database:h.database});
 assert.equal(restarted.store.getState().projects[0].nodes[0].metadata.content,'already committed');
 assert.equal(restarted.store.getState().projects[0].__desktopRevision,'revision-1');
 await restarted.store.getState().retrySave(original.id);assert.equal(restarted.writes.length,0);
 assert.equal(restarted.values.has('infinite-canvas:save-journal:'+original.id),false);
});

test('history restore flushes the current edit, receives the latest revision, and persists the restored snapshot',async()=>{
 const h=await storeHarness();h.store.getState().updateProject(original.id,{nodes:[{id:'n',type:'text',title:'原节点',position:{x:0,y:0},width:240,height:160,metadata:{content:'new edit'}}]});
 await h.store.getState().restoreVersion(original.id,7);
 assert.equal(h.writes.length,1);assert.equal(h.restores[0].expectedRevision,'revision-1');assert.match(h.restores[0].requestId,/^[a-f0-9-]{36}$/);
 assert.equal(h.database.get(original.id).__desktopRevision,'restored-7');assert.equal(h.store.getState().restoredRevisions[original.id],'restored-7');assert.equal(h.store.getState().projects[0].nodes[0].metadata.content,'saved');
 assert.equal(JSON.parse(h.values.get('infinite-canvas:canvas_project:'+original.id)).__desktopRevision,'restored-7');
 assert.equal(h.store.getState().saveStatus[original.id].state,'saved');
});

test('history preview becomes stale after an edit and active media or chat tasks block restoration',async()=>{
 const stale=await storeHarness();stale.store.getState().updateProject(original.id,{nodes:[{id:'n',type:'text',title:'原节点',position:{x:0,y:0},width:240,height:160,metadata:{content:'edited after preview'}}]});
 await assert.rejects(stale.store.getState().restoreVersion(original.id,1,'base'),/重新预览/);assert.equal(stale.restores.length,0);
 for(const patch of [
  {nodes:[{id:'n',type:'image',metadata:{status:'loading'}}]},
  {chatSessions:[{id:'session',messages:[{status:'running'}]}]},
  {pendingAgentRequest:{prompt:'pending'}},
 ]) {
  const h=await storeHarness();h.store.getState().updateProject(original.id,patch);
  await assert.rejects(h.store.getState().restoreVersion(original.id,1),/停止当前画布/);assert.equal(h.restores.length,0);
 }
});

test('edits arriving during restore survive in recovery and cannot silently overwrite the restored database',async()=>{
 const h=await storeHarness();let release;const gate=new Promise(resolve=>{release=resolve});h.beforeRestore(()=>gate);
 const restoring=h.store.getState().restoreVersion(original.id,3);
 for(let i=0;i<100&&!h.restores.length;i++)await tick(1);
 h.store.getState().updateProject(original.id,{nodes:[{id:'n',type:'text',title:'原节点',position:{x:0,y:0},width:240,height:160,metadata:{content:'edit while restoring'}}]});
 await tick(450);assert.equal(h.writes.length,0);release();await assert.rejects(restoring,/恢复期间又有新编辑/);
 assert.equal(h.database.get(original.id).nodes[0].metadata.content,'saved');
 assert.equal(h.store.getState().projects[0].nodes[0].metadata.content,'edit while restoring');
 assert.equal(JSON.parse(h.values.get('infinite-canvas:save-journal:'+original.id)).project.nodes[0].metadata.content,'edit while restoring');
 assert.equal(h.store.getState().saveStatus[original.id].state,'error');
 await assert.rejects(h.store.getState().retrySave(original.id),/REVISION_CONFLICT/);
});

function mediaHarness({failure=false}={}) {
 const bytes=Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3]).buffer;const calls=[];
 class Reader {readAsDataURL(blob){blob.arrayBuffer().then(buffer=>{this.result=`data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;this.onload()}).catch(()=>this.onerror())}}
 const media=load('services/canvas-media.ts',{'@tauri-apps/api/core':{isTauri:()=>true,invoke:async(command,args)=>{calls.push({command,args});if(failure)throw Error('missing original');return bytes}},'@/services/file-storage':{getMediaBlob:async()=>null},'@/services/image-storage':{getImageBlob:async()=>null,imageToDataUrl:async ref=>ref.dataUrl}},{FileReader:Reader});
 return {media,bytes,calls};
}

test('local-ref model input resolves exact image bytes and a failed read aborts sending',async()=>{
 const h=mediaHarness();const ref={id:'img',title:'原图',dataUrl:'local-ref:asset-a',storageKey:'local-ref:asset-a',mimeType:'image/png'};
 const refs=await h.media.resolveCanvasModelReferences('film',[ref]);
 assert.deepEqual(Buffer.from(refs[0].dataUrl.split(',')[1],'base64'),Buffer.from(h.bytes));
 assert.equal(ref.dataUrl,'local-ref:asset-a');assert.equal(h.calls[0].args.projectId,'film');
 await assert.rejects(mediaHarness({failure:true}).media.resolveCanvasModelReferences('film',[ref]),/原图.*missing original/);
});

test('local-ref export embeds and hashes media; import remaps it and rejects missing bytes',async()=>{
 const h=mediaHarness();let archive;
 const zip=load('lib/zip.ts',{fflate:requireWeb('fflate')});
 const exporter=load(canvasPath+'utils/canvas-export.ts',{'file-saver':{saveAs:blob=>{archive=blob}},'@/lib/zip':zip,'@/services/canvas-media':h.media,'@/services/desktop-runtime':{isDesktopRuntime:()=>false}});
 const project={...original,nodes:[{id:'img',type:'image',metadata:{content:'local-ref:asset-a',storageKey:'local-ref:asset-a',mimeType:'image/png',localMedia:{storageKey:'local-ref:asset-a',rootId:'agent-media'}}}]};
 await exporter.exportCanvasProjects([project]);const entries=await zip.readZip(archive);const manifest=JSON.parse(await entries.get('projects.json').text());
 assert.equal(manifest.projects[0].files.length,1);assert.equal(manifest.projects[0].files[0].bytes,h.bytes.byteLength);assert.match(manifest.projects[0].files[0].sha256,/^[a-f0-9]{64}$/);
 const importedBytes=[];
 const importer=load(canvasPath+'utils/canvas-import.ts',{nanoid:{nanoid:()=> 'fresh-id'},'@/lib/zip':zip,'@/services/image-storage':{setImageBlob:async(key,blob)=>{importedBytes.push({key,blob});return 'blob:fresh'}},'@/services/file-storage':{setMediaBlob:async()=>{throw Error('wrong media store')}},'./canvas-export':exporter,'./canvas-graph':graph});
 const imported=await importer.importCanvasArchive(archive);assert.equal(imported[0].nodes[0].metadata.storageKey,'image:fresh-id');assert.equal(imported[0].nodes[0].metadata.content,'blob:fresh');assert.equal(imported[0].nodes[0].metadata.localMedia,undefined);
 assert.deepEqual(Buffer.from(await importedBytes[0].blob.arrayBuffer()),Buffer.from(h.bytes));
 const incomplete=await zip.createZip([{name:'projects.json',data:JSON.stringify(manifest)}]);await assert.rejects(importer.importCanvasArchive(incomplete),/缺失/);
});

async function conflictHarness() {
 const h=await storeHarness();
 h.store.getState().updateProject(original.id,{nodes:[{...original.nodes[0],metadata:{content:'local draft'}}]});
 h.database.set(original.id,{...structuredClone(original),__desktopRevision:'external-2',nodes:[{...original.nodes[0],metadata:{content:'external latest'}}]});
 await h.store.getState().refreshFromDesktop();
 return h;
}
test('conflict stops timers, explicit retry and restart loops without blocking another project',async()=>{
 const h=await conflictHarness();const initialWrites=h.writes.length;
 h.store.getState().updateProject(original.id,{nodes:[{...original.nodes[0],metadata:{content:'continued draft'}}]});
 for(let i=0;i<3;i++)await h.store.getState().refreshFromDesktop();
 await assert.rejects(h.store.getState().retrySave(original.id),/其他修改/);
 await tick(450);assert.equal(h.writes.length,initialWrites);
 const second=h.store.getState().createProject('unrelated');await h.store.getState().retrySave(second);
 assert.equal(h.store.getState().saveStatus[second].state,'saved');
 const restart=await storeHarness({storage:h.values,database:h.database});await restart.store.getState().refreshFromDesktop();
 assert.equal(restart.store.getState().saveStatus[original.id].state,'conflict');assert.equal(restart.writes.length,0);
 assert.equal(restart.store.getState().openProject(original.id).nodes[0].metadata.content,'continued draft');
});
test('adopt latest archives full draft, resets editor, saves next edit and survives restart',async()=>{
 const h=await conflictHarness();const c=await h.store.getState().inspectSaveConflict(original.id);
 assert.equal(c.nodes.changed.length,1);assert.equal(c.latestRevision,'external-2');
 const resolved=await h.store.getState().resolveSaveConflict(original.id,'latest',c.draftToken);
 assert.equal(JSON.parse(h.values.get(resolved.archiveKey)).project.nodes[0].metadata.content,'local draft');
 assert.equal(h.store.getState().openProject(original.id).nodes[0].metadata.content,'external latest');
 assert.match(h.store.getState().restoredRevisions[original.id],/^external-2:/);
 h.store.getState().updateProject(original.id,{nodes:[{...original.nodes[0],metadata:{content:'after adopt'}}]});await h.store.getState().retrySave(original.id);
 const restart=await storeHarness({storage:h.values,database:h.database});
 assert.equal(restart.store.getState().openProject(original.id).nodes[0].metadata.content,'after adopt');
 assert.equal(restart.store.getState().openProject(original.id).__desktopRevision,h.database.get(original.id).__desktopRevision);
});
test('copy preserves media and task provenance without touching or resubmitting original tasks',async()=>{
 const h=await conflictHarness();h.store.getState().updateProject(original.id,{nodes:[{...original.nodes[0],type:'image',metadata:{content:'local-ref:retained',status:'loading',imageTaskId:'existing-task'}}],pendingAgentRequest:{prompt:'do not run',assets:[]}});
 const before=JSON.stringify(h.database.get(original.id));
 const result=await h.store.getState().resolveSaveConflict(original.id,'copy',undefined,'copy-request');
 const p=h.database.get(result.projectId);assert.equal(p.recoveryCopyOf,original.id);assert.equal(p.nodes[0].metadata.imageTaskId,'existing-task');assert.equal(p.nodes[0].metadata.status,'error');assert.equal(p.nodes[0].metadata.content,'local-ref:retained');assert.equal(p.pendingAgentRequest,undefined);assert.equal(JSON.stringify(h.database.get(original.id)),before);
 assert.equal(h.store.getState().saveStatus[original.id].state,'conflict');
 const second=await h.store.getState().resolveSaveConflict(original.id,'copy',undefined,'copy-request');assert.equal(result.projectId,second.projectId);
});
test('new edits during backup and a second external change both abort adoption safely',async()=>{
 const h=await conflictHarness();let edited=false;
 h.beforeLocalWrite(async key=>{if(key.startsWith('infinite-canvas:save-archive:')&&!edited){edited=true;h.store.getState().updateProject(original.id,{nodes:[{...original.nodes[0],metadata:{content:'typing during resolution'}}]})}});
 await assert.rejects(h.store.getState().resolveSaveConflict(original.id,'latest'),/新编辑/);
 assert.equal(h.store.getState().openProject(original.id).nodes[0].metadata.content,'typing during resolution');
 h.beforeLocalWrite(async()=>{});let reads=0;
 h.beforeRead(async()=>{if(++reads===2)h.database.set(original.id,{...h.database.get(original.id),__desktopRevision:'external-3',title:'new external title'})});
 await assert.rejects(h.store.getState().resolveSaveConflict(original.id,'latest'),/又被修改/);
 const restart=await storeHarness({storage:h.values,database:h.database});assert.equal(restart.store.getState().openProject(original.id).nodes[0].metadata.content,'typing during resolution');assert.equal(restart.store.getState().saveStatus[original.id].state,'conflict');
});
test('failed backup or adoption marker never discards the only draft',async()=>{
 for(const prefix of ['infinite-canvas:save-archive:','infinite-canvas:save-journal:']){
  const h=await conflictHarness();h.beforeLocalWrite(async(key,value)=>{if(key.startsWith(prefix)&&(prefix.includes('archive')||JSON.parse(value).adopted))throw Error('injected resolution disk failure')});
  await assert.rejects(h.store.getState().resolveSaveConflict(original.id,'latest'),/disk failure/);
  const restart=await storeHarness({storage:h.values,database:h.database});assert.equal(restart.store.getState().openProject(original.id).nodes[0].metadata.content,'local draft');
 }
});
test('late save reply cannot undo a resolution and revision-only receipts reach cache',async()=>{
 const h=await storeHarness();let release;const gate=new Promise(resolve=>{release=resolve});h.beforeSave(()=>gate);
 h.store.getState().updateProject(original.id,{nodes:[{...original.nodes[0],metadata:{content:'sent'}}]});const saving=h.store.getState().retrySave(original.id);
 for(let i=0;i<100&&!h.writes.length;i++)await tick(1);
 const resolution=h.store.getState().resolveSaveConflict(original.id,'latest');release();await saving;await resolution;
 assert.equal(h.store.getState().saveStatus[original.id].state,'saved');assert.equal(h.store.getState().openProject(original.id).__desktopRevision,'revision-1');
 assert.equal(JSON.parse(h.values.get('infinite-canvas:canvas_project:'+original.id)).__desktopRevision,'revision-1');
});
test('missing saved project is retained for explicit copy and never recreated on refresh',async()=>{
 const h=await storeHarness({database:new Map()});await h.store.getState().refreshFromDesktop();assert.equal(h.writes.length,0);assert.equal(h.store.getState().saveStatus[original.id].code,'PROJECT_MISSING');assert.equal(h.database.has(original.id),false);
});
test('typing after adoption while cache is committing is saved using the adopted revision',async()=>{
 const h=await conflictHarness();let changed=false;
 h.beforeLocalWrite(async(key)=>{
  if(key==='infinite-canvas:canvas_project:'+original.id && h.store.getState().openProject(original.id).nodes[0].metadata.content==='external latest'&&!changed){changed=true;h.store.getState().updateProject(original.id,{nodes:[{...original.nodes[0],metadata:{content:'typed on new version'}}]})}
 });
 await h.store.getState().resolveSaveConflict(original.id,'latest');
 assert.equal(h.database.get(original.id).nodes[0].metadata.content,'typed on new version');assert.equal(h.writes[0].__desktopRevision,'external-2');assert.equal(h.store.getState().saveStatus[original.id].state,'saved');
});
test('one project shard failing does not block or mark another project save failed',async()=>{
 const h=await conflictHarness();
 h.beforeLocalWrite(async(key)=>{if(key==='infinite-canvas:canvas_project:'+original.id)throw Error('bad shard')});
 const second=h.store.getState().createProject('healthy');await h.store.getState().retrySave(second);await tick(450);
 assert.equal(h.database.get(second).title,'healthy');assert.equal(h.store.getState().saveStatus[second].state,'saved');assert.equal(h.database.get(original.id).nodes[0].metadata.content,'external latest');
});
test('an interrupted adoption after the durable marker restores latest instead of the old draft',async()=>{
 const h=await conflictHarness();await h.store.getState().resolveSaveConflict(original.id,'latest');
 h.values.set('infinite-canvas:recovery:index',JSON.stringify([original.id]));
 h.values.set('infinite-canvas:recovery:project:'+original.id,JSON.stringify({...original,__desktopRevision:'old'}));
 const restart=await storeHarness({storage:h.values,database:h.database});await restart.store.getState().refreshFromDesktop();
 assert.equal(restart.writes.length,0);assert.equal(restart.store.getState().openProject(original.id).nodes[0].metadata.content,'external latest');
});


test('burst edits coalesce draft checkpoints while preserving the final durable edit',async()=>{
 const h=await storeHarness();let journals=0;
 h.beforeLocalWrite(async key=>{if(key.startsWith('infinite-canvas:save-journal:')) {journals++;await tick(5);}});
 for(let i=0;i<300;i++) h.store.getState().updateProject(original.id,{nodes:[{...original.nodes[0],metadata:{content:'burst '+i}}]});
 await h.store.getState().retrySave(original.id);
 assert.equal(h.database.get(original.id).nodes[0].metadata.content,'burst 299');
 assert.ok(journals<=4,`expected merged checkpoints, got ${journals}`);
 assert.equal(h.values.has('infinite-canvas:save-journal:'+original.id),false);
});

test('desktop listing fetches summaries and only opens the requested body, sequentially',async()=>{
 const calls=[];let active=0,peak=0;
 const service=load('services/desktop-runtime.ts',{'@tauri-apps/api/core':{invoke:async(name,args)=>{
  calls.push([name,args]);active++;peak=Math.max(peak,active);await tick();active--;
  if(name==='desktop_canvas_summaries')return [{id:'one',updatedAt:'same',__desktopSummary:true},{id:'two',updatedAt:'same',__desktopSummary:true}];
  if(name==='desktop_canvas_project_revision')return 'r1';
  if(name==='desktop_canvas_document')return {project:{id:args.projectId,updatedAt:'same',nodes:[{id:'image'}]},revision:'r1'};
  throw Error(name);
 }}});
 const listed=await service.loadDesktopCanvasProjects();assert.equal(calls.length,1);assert.equal(listed.projects.length,2);
 const opened=await service.loadDesktopCanvasProjects(listed.projects,['two']);assert.equal(opened.projects[1].nodes.length,1);
 assert.equal(calls.filter(c=>c[0]==='desktop_canvas_document').length,1);assert.equal(peak,1);
 await service.loadDesktopCanvasProjects(opened.projects,['two']);assert.equal(calls.filter(c=>c[0]==='desktop_canvas_document').length,1);
});


test('inline image task results are persisted once before entering canvas metadata',async()=>{
 const source=readFileSync(new URL('../../web/src/services/api/image.ts',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('export async function normalizeCanvasImageTask('));
 const js=ts.transpileModule(fn,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 let stored=0;const context={exports:{},persistCanvasInlineImage:async data=>{stored++;assert.equal(data,'data:image/png;base64,aGVsbG8=');return {storageKey:'local-ref:original',content:'local-ref:original',localMedia:{sha256:'hash'}}}};
 vm.runInNewContext(js,context);
 const task={id:'t',status:'completed',image_url:'data:image/png;base64,aGVsbG8=',image_urls:['data:image/png;base64,aGVsbG8=']};
 const next=await context.exports.normalizeCanvasImageTask(task);
 assert.equal(stored,1);assert.equal(next.image_url,'local-ref:original');assert.equal(next.image_urls[0],next.image_url);
 assert.equal(next.media[next.image_url].localMedia.sha256,'hash');assert.equal(JSON.stringify(next).includes('base64'),false);
 assert.equal(task.image_url.startsWith('data:'),true);
});
