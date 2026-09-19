// Execute the real page sync and autosave effect at the cache-await boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const ts=createRequire(new URL('../../web/package.json',import.meta.url))('typescript');
const source=readFileSync(new URL('../../web/src/app/(user)/canvas/[id]/canvas-client-page.tsx',import.meta.url),'utf8');
const syncStart=source.indexOf('    const syncCanvasDocument = useCallback(');
const sync=source.slice(syncStart,source.indexOf('\n    const executeRetryNode',syncStart));
const effectEnd=source.indexOf('\n    useEffect(() => {\n        if (!projectLoaded) return;\n        const pollCanvasTasks');
const effect=source.slice(source.lastIndexOf('    useEffect(() => {',effectEnd-1),effectEnd);
const code=ts.transpileModule(sync+'\n'+effect+'\nexports.sync=syncCanvasDocument;', {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness() {
 let project={id:'fixture',nodes:[{id:'old'}],connections:[]};let commit,fail,autosave;
 const cache=new Promise((resolve,reject)=>{commit=resolve;fail=reject});const writes=[];
 const context={exports:{},projectId:'fixture',projectLoaded:true,useCallback:fn=>fn,useEffect:fn=>{autosave=fn},equal:(a,b)=>JSON.stringify(a)===JSON.stringify(b),
  useCanvasStore:{getState:()=>({projects:[project]})},updateProject:(_,patch)=>writes.push(patch),
  nodes:project.nodes,connections:project.connections,chatSessions:[],activeChatId:null,agentConfig:null,backgroundMode:'lines',showImageInfo:false,
  nodesRef:{current:project.nodes},connectionsRef:{current:project.connections},historyPausedRef:{current:false},historyRef:{current:{past:[],future:[]}},externalSnapshotRef:{current:null},viewportRef:{current:{}},lastHistoryRef:{current:null},
  createHistoryEntry:()=>({}),setHistoryState:()=>{},setSelectedNodeIds:()=>{},setViewport:()=>{},setSidePanel:()=>{},setAgentPanel:()=>{},
  acceptDesktopCanvasDocument:next=>{project=next;queueMicrotask(()=>autosave());return cache},
 };
 for(const key of ['nodes','connections','chatSessions','activeChatId','agentConfig','backgroundMode','showImageInfo'])context['set'+key[0].toUpperCase()+key.slice(1)]=value=>{context[key]=value};
 Object.defineProperty(context,'currentProject',{get:()=>project});vm.runInNewContext(code,context);
 return {context,writes,commit,fail,run:()=>context.exports.sync({revision:'new-revision',project:{id:'fixture',nodes:[{id:'old'},{id:'external'}],connections:[]}})};
}
test('remote snapshot reaches editor before autosave observes the new store revision',async()=>{
 const h=harness();const saving=h.run();await Promise.resolve();
 assert.equal(h.context.nodes.length,2);assert.equal(h.writes.length,0);
 h.commit();await saving;assert.equal(h.writes.length,0);
});
test('cache failure cannot write the old editor nodes over an accepted remote revision',async()=>{
 const h=harness();const saving=h.run();h.fail(new Error('cache unavailable'));
 await assert.rejects(saving,/cache unavailable/);assert.equal(h.context.nodes.length,2);assert.equal(h.writes.length,0);
});
test('unpersisted editor changes reject remote sync before changing the store',async()=>{
 const h=harness();h.context.nodesRef.current=[{id:'unsaved'}];
 await assert.rejects(h.run(),/尚未保存/);assert.equal(h.context.currentProject.nodes[0].id,'old');
});
