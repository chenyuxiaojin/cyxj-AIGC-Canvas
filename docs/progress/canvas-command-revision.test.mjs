// Exercise the production commit closure with an old sidebar and a fresh durable command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const ts=createRequire(new URL('../../web/package.json',import.meta.url))('typescript');
const source=readFileSync(new URL('../../web/src/app/(user)/canvas/[id]/canvas-client-page.tsx',import.meta.url),'utf8');
const start=source.indexOf('        async (action: CanvasAgentAction, messageReferenceNodeIds: string[], commandRevision?');
assert.ok(start>0);
const block=source.slice(start,source.indexOf('            const nextNodeCenter',start));
const code=ts.transpileModule('exports.prepare = '+block+'return commitAgentOperations; };',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness() {
 let project={id:'fixture',nodes:[],connections:[],operationState:{revision:746}};
 const batches=[];
 const context={exports:{},projectId:'fixture',agentExpectedRevisionRef:{current:745},nodesRef:{current:[]},connectionsRef:{current:[]},CANVAS_OPERATION_PROTOCOL_VERSION:1,setNodes:()=>{},setConnections:()=>{},
  useCanvasStore:{getState:()=>({projects:[project]})},applyOperationBatch:batch=>{
    batches.push(batch);
    if(batch.baseRevision!==project.operationState.revision)return {project,result:{ok:false,revision:project.operationState.revision,error:{code:'stale_revision'}}};
    project={...project,operationState:{revision:project.operationState.revision+1}};return {project,result:{ok:true}};
  }};
 vm.runInNewContext(code,context);
 return {context,batches,prepare:revision=>context.exports.prepare({id:'test',arguments:{}},[],revision),change:()=>{project.operationState.revision++}};
}
test('command uses 746 while sidebar remembers 745; next command has an independent base',async()=>{
 const h=harness();assert.ok((await h.prepare(746))([]).outcome);assert.equal(h.context.agentExpectedRevisionRef.current,745);
 h.change();assert.ok((await h.prepare(748))([]).outcome);assert.deepEqual(h.batches.map(b=>b.baseRevision),[746,748]);
});
test('genuine concurrent mutation still rejects an already prepared command',async()=>{
 const h=harness();const commit=await h.prepare(746);h.change();assert.equal(commit([]).error.code,'stale_revision');
});
test('stale sidebar stays rejected; successful sidebar action advances its own revision',async()=>{
 const h=harness();assert.equal((await h.prepare())([]).error.code,'stale_revision');
 h.context.agentExpectedRevisionRef.current=746;assert.ok((await h.prepare())([]).outcome);assert.equal(h.context.agentExpectedRevisionRef.current,747);
});

const pollStart=source.indexOf('    useEffect(() => {\n        if (!projectLoaded) return;\n        const pollCanvasTasks');
const pollEnd=source.indexOf('\n    useEffect(',pollStart+10);
const pollCode=ts.transpileModule(source.slice(pollStart,pollEnd),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
test('hidden desktop polls accepted tasks and cleans up; hidden browser still pauses',async()=>{
 for(const desktopRuntime of [true,false]) {
  let polls=0,timers=0,cleanup,visibility;
  const context={desktopRuntime,projectLoaded:true,projectId:'fixture',effectiveConfig:{},isAiConfigReady:()=>true,
   useEffect:fn=>{cleanup=fn()},useCanvasStore:{getState:()=>({saveStatus:{}})},
   nodesRef:{current:[{id:'video',type:'video',metadata:{status:'loading',channelId:'fixture',videoTaskId:'already-submitted'}}]},
   pollingVideoNodeIdsRef:{current:new Set()},pollingLocalNodeIdsRef:{current:new Set()},CanvasNodeType:{Video:'video'},NODE_STATUS_LOADING:'loading',
   canvasVideoTaskId:meta=>meta.videoTaskId,canvasVideoTaskFromMetadata:meta=>({id:meta.videoTaskId}),normalizeLocalChannels:()=>[{id:'fixture'}],buildGenerationConfig:()=>({}),
   pollVideoGenerationTaskStatus:async(_,task)=>{assert.equal(task.id,'already-submitted');polls++;return {status:'completed'}},setNodes:()=>{},
   VIDEO_POLL_INTERVAL_MS:5000,window:{setInterval:()=>++timers,clearInterval:()=>timers--},
   document:{hidden:true,addEventListener:(_,fn)=>{visibility=fn},removeEventListener:()=>{}}};
  vm.runInNewContext(pollCode,context);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(polls,desktopRuntime?1:0);assert.equal(timers,desktopRuntime?1:0);
  visibility();await new Promise(resolve=>setImmediate(resolve));assert.equal(timers,desktopRuntime?1:0);
  cleanup();assert.equal(timers,0);
 }
});
