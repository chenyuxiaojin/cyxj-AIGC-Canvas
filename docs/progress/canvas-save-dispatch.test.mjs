// Real dispatcher, simulated App IPC/executor. No live generation or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const requireWeb=createRequire(new URL('../../web/package.json',import.meta.url));
const ts=requireWeb('typescript');
const source=readFileSync(new URL('../../web/src/components/layout/canvas-command-dispatcher.tsx',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function harness(action,status='queued',saveState='saved',baseRevision='latest') {
 const task={task_id:'fixture-request',project_id:'fixture-project',status,request:{action,base_revision:baseRevision,arguments:{draftToken:'draft:1'}}};
 const calls=[];let poll;let cleanup;let executing=0;
 const store={hydrated:true,saveStatus:{'fixture-project':{state:saveState}},projects:[{id:'fixture-project',__desktopRevision:'latest'}],
  inspectSaveConflict:async id=>{calls.push(['inspect',id]);return {draftToken:'draft:1'}},resolveSaveConflict:async(...args)=>{calls.push(['resolve',...args]);return {projectId:args[0]}}};
 const active={projectId:'fixture-project',busy:()=>false,flush:async()=>{calls.push(['flush']);if(saveState==='conflict')throw Error('conflict')},sync:async()=>{},execute:async()=>{executing++;return {ok:true}}};
 const imports={react:{useRef:value=>({current:value}),useEffect:fn=>{cleanup=fn()}},'next/navigation':{useRouter:()=>({push:url=>calls.push(['navigate',url])})},antd:{App:{useApp:()=>({message:{error:()=>{}}})}},
  '@/services/desktop-runtime':{isDesktopRuntime:()=>true,canvasPersistenceError:error=>({code:'TEST',message:String(error)})},
  '@/app/(user)/canvas/stores/use-canvas-store':{useCanvasStore:{getState:()=>store}},
  '@/services/canvas-commands':{currentCanvasExecutor:()=>active,listCanvasCommands:async()=>[task],claimCanvasCommand:async()=>{assert.equal(task.status,'queued');task.status='running';calls.push(['claim'])},finishCanvasCommand:async(_,result)=>{task.status=result.ok?'succeeded':'failed';task.result=result;calls.push(['finish'])},readCanvasDocument:async()=>({project:{id:active.projectId},revision:'latest'}),getCanvasCommand:async()=>task}};
 const module={exports:{}};vm.runInNewContext(js,{module,exports:module.exports,require:name=>{assert.ok(imports[name],name);return imports[name]},setInterval:fn=>{poll=fn;return 1},clearInterval:()=>{}});
 module.exports.CanvasCommandDispatcher();await tick();await tick();
 return {task,calls,active,store,poll:async()=>{await poll();await tick()},executions:()=>executing,close:()=>cleanup()};
}
test('new generation is claimed and executed once without a canvas approval',async()=>{
 const h=await harness('generate_video');assert.equal(h.task.status,'succeeded');assert.equal(h.executions(),1);await h.poll();assert.equal(h.executions(),1);h.close();
});
test('historical pending approval is neither submitted nor cancelled by upgrade',async()=>{
 const h=await harness('generate_video','pending_approval');await h.poll();assert.equal(h.task.status,'pending_approval');assert.equal(h.executions(),0);assert.equal(h.calls.some(c=>c[0]==='claim'),false);h.close();
});
test('recovery inspection and choices bypass conflicted ordinary flush',async()=>{
 for(const action of ['save_inspect','save_use_latest','save_copy']) {
  const h=await harness(action,'queued','conflict');assert.equal(h.task.status,'succeeded');assert.equal(h.executions(),0);assert.equal(h.calls.some(c=>c[0]==='flush'),false);h.close();
 }
});
test('opening a canvas remains possible from a conflicted editor',async()=>{
 const h=await harness('open_project','queued','conflict');assert.equal(h.calls.some(c=>c[0]==='navigate'),true);await h.poll();assert.equal(h.task.status,'succeeded');h.close();
});

const panel=readFileSync(new URL('../../web/src/app/(user)/canvas/components/canvas-assistant-panel.tsx',import.meta.url),'utf8');
const actionStart=panel.indexOf('                executeAction: async (action: CanvasAgentAction)');
const actionEnd=panel.indexOf('                signal: controller.signal,',actionStart);
const actionCode=ts.transpileModule('const runtime={'+panel.slice(actionStart,actionEnd)+'}; exports.run=runtime.executeAction;',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
for(const name of ['generate_video','delete_node'])test(`assistant ${name} keeps result reporting and only deletion asks for confirmation`,async()=>{
 let executions=0,confirmations=0,reports=0;
 const context={exports:{},provider:'codex',controller:new AbortController(),messageReferenceNodeIds:[],nodes:[],batchId:'fixture',
  onExecuteAction:async()=>{executions++;return {ok:true}},onAgentActionResult:()=>{reports++},requestConfirmation:async()=>{confirmations++;return true}};
 vm.runInNewContext(actionCode,context);const result=await context.exports.run({name,arguments:{nodeId:'fixture'}});
 assert.equal(result.ok,true);assert.equal(executions,1);assert.equal(reports,1);assert.equal(confirmations,name==='delete_node'?1:0);
});

test('stale durable command is rejected before any generation executor call',async()=>{
 const h=await harness('generate_video','queued','saved','old-document');
 assert.equal(h.task.status,'failed');assert.equal(h.task.result.code,'REVISION_CONFLICT');assert.equal(h.executions(),0);h.close();
});
