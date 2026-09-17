import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
const root=fileURLToPath(new URL('../../web/src/',import.meta.url));
const requireWeb=createRequire(new URL('../../web/package.json',import.meta.url));
const ts=requireWeb('typescript');
function loader(mocks={}) {
 const cache=new Map();
 function load(file) {
  if(cache.has(file))return cache.get(file).exports;
  const module={exports:{}}; cache.set(file,module);
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,console,URL,FormData,File,Blob,crypto,setTimeout,clearTimeout,require(name){
   if(name in mocks)return mocks[name];
   if(name==='@/services/api/request')return {apiGet(){throw Error('Unexpected network');}};
   if(name.startsWith('@/')||name.startsWith('.')) {
    const base=name.startsWith('@/')?path.join(root,name.slice(2)):path.resolve(path.dirname(file),name);
    const resolved=['.ts','.tsx','/index.ts','/index.tsx'].map(x=>base+x).find(existsSync);assert.ok(resolved,name);return load(resolved);
   }
   return requireWeb(name);
  }},{filename:file}); return module.exports;
 }
 return name=>load(path.join(root,name));
}
const load=loader();
const settings=load('stores/use-config-store.ts');
const seedance=load('lib/seedance-video.ts');
const {parseOpenAIChatVideoResponse:parse}=load('lib/openai-chat-video.ts');
test('root or versioned base URL reaches the same OpenAI endpoint',()=>{
 for(const base of ['https://api.laogou.org','https://api.laogou.org/','https://api.laogou.org/v1','https://api.laogou.org/v1/'])assert.equal(settings.buildApiUrl(base,'/chat/completions'),'https://api.laogou.org/v1/chat/completions');
});
test('Seedance 2.5 permits 30 seconds and retains older model limits',()=>{
 for(const model of ['seedance2.5','seedance-2-5','doubao-seedance-2-5-260628']){
  assert.equal(seedance.normalizeSeedanceDuration('30',model),30);
  assert.ok(seedance.seedanceDurationOptionsForModel(model).includes(30));
 }
 assert.equal(seedance.normalizeSeedanceDuration('30','seedance2.0'),15);
 assert.equal(seedance.normalizeSeedanceDuration('-1','seedance2.5'),-1);
});
test('completed replies accept markdown, nested URL and split streaming chunks',()=>{
 for(const data of [
  {choices:[{message:{content:'完成 [下载](https://cdn.example/film.mp4?token=a&b=c)'}}]},
  {data:{video_url:'https://cdn.example/film.mp4?token=a&b=c'}},
  'data: {"choices":[{"delta":{"content":"https://cdn.example/fi"}}]}\n\ndata: {"choices":[{"delta":{"content":"lm.mp4?token=a&b=c"}}]}\n\ndata: [DONE]\n',
 ])assert.equal(parse(data,'client-id').video_url,'https://cdn.example/film.mp4?token=a&b=c');
});
test('errors, HTML, or chat-only IDs never masquerade as accepted video tasks',()=>{
 assert.throws(()=>parse('<html>login</html>','fallback'),/非 JSON/);
 assert.throws(()=>parse({error:{message:'upstream failed'}},'fallback'),/upstream failed/);
 assert.throws(()=>parse({id:'chatcmpl-123',choices:[{message:{content:'处理中'}}]},'fallback'),/没有返回视频/);
 assert.equal(parse({task_id:'video-123',status:'queued'},'fallback').id,'video-123');
});
function fixture(post, get = () => { throw Error("Unexpected polling"); }, mode = "chat") {
 const calls=[];
 const channel={id:'video-channel',name:'video',protocol:'openai',videoApiMode:mode,models:['seedance2.5'],baseUrl:'https://api.laogou.org/v1',apiKey:'test-only'};
 const config={...settings.useConfigStore.getState().config,channelMode:'local',model:'seedance2.5',videoModel:'seedance2.5',activeChannelId:channel.id,videoChannelId:channel.id,localChannels:[channel],size:'16:9',videoSeconds:'30',vquality:'1080p',videoGenerateAudio:'true',systemPrompts:{video:''},systemPrompt:''};
 const mocks={
  axios:{post:async(...args)=>{calls.push(args);return post(...args);},get:async (...args)=>{calls.push(args);return get(...args);},isAxiosError:e=>e?.isAxiosError===true},
  '@/stores/use-config-store':settings,
  '@/stores/use-user-store':{useUserStore:{getState:()=>({token:''})}},
  '@/services/image-storage':{imageToDataUrl:async image=>image.dataUrl},
  '@/services/file-storage':{uploadMediaFile:async blob=>({url:'blob:stored-video',storageKey:'video:stored',bytes:blob.size})},'@/services/media-public-url':{},
  '@/components/video-settings-panel':{},
 };
 return {api:loader(mocks)('services/api/video.ts'),config,calls};
}
test('first scene sends six base64 references, 30 seconds and audio in one JSON request',async()=>{
 const {api,config,calls}=fixture(()=>({data:{id:'chatcmpl-1',choices:[{message:{content:'[视频](https://cdn.example/movie.mp4)'}}]}}));
 const references=Array.from({length:6},(_,i)=>({id:String(i),dataUrl:`data:image/png;base64,${i}`}));
 const created=await api.createVideoGenerationTask(config,'原始提示词',references,undefined,{clientTaskId:'first-scene'});
 assert.equal(calls.length,1);const [url,body,options]=calls[0];
 assert.equal(url,'/api/ai/laogou/v1/chat/completions');
 assert.equal(body.duration,30);assert.equal(body.generate_audio,true);assert.equal(body.aspect_ratio,'16:9');assert.equal(body.resolution,'1080p');assert.equal(body.stream,false);
 assert.equal(body.messages[0].content.length,7);assert.equal(body.messages[0].content[0].text,'原始提示词');
 assert.equal(body.messages[0].content[6].image_url.url,references[5].dataUrl);
 assert.equal(options.headers.Authorization,'Bearer test-only');assert.equal(options.timeout,900000);
 const result=await api.pollCreatedVideoGenerationTask(config,created.task);
 assert.equal(result.url,'https://cdn.example/movie.mp4');assert.equal(result.width,1920);assert.equal(result.height,1080);
 assert.equal((await api.pollVideoGenerationTaskStatus(config,created.task)).status,'completed');
});
test('a rejected generation retains endpoint and request ID and does not resubmit',async()=>{
 const {api,config,calls}=fixture(()=>{throw {isAxiosError:true,response:{status:404,headers:{'x-request-id':'upstream-id'},data:{error:{message:'Not Found'}}}};});
 await assert.rejects(()=>api.createVideoGenerationTask(config,'scene'),error=>{
  assert.match(error.message,/Not Found/);assert.match(error.detail,/upstream-id/);assert.match(error.detail,/404/);assert.match(error.detail,/\/v1\/chat\/completions/);return true;
 });assert.equal(calls.length,1);
});
test('unsupported reference types fail before starting a paid request',async()=>{
 const {api,config,calls}=fixture(()=>{throw Error('Must not send');});
 await assert.rejects(()=>api.createVideoGenerationTask(config,'scene',{firstFrame:{dataUrl:'data:image/png;base64,x'}}),/普通参考图/);
 assert.equal(calls.length,0);
});

test('local transport only rewrites the exact provider and allowed paths',()=>{
 const {localVideoGatewayUrl:route}=load('lib/local-video-gateway.ts');
 assert.equal(route('https://api.laogou.org/v1/models'),'/api/ai/laogou/v1/models');
 for(const url of ['https://api.laogou.org.evil.test/v1/models','https://elsewhere.test/v1/models','https://api.laogou.org/v1/usage','https://user@api.laogou.org/v1/models'])assert.equal(route(url),url);
});

test('reopened canvas keeps all six stored image references without temporary display URLs',()=>{
 const {buildNodeGenerationContext}=load('app/(user)/canvas/components/canvas-node-generation.ts');
 const names=['face','costume','george','umbrella','exterior','interior'];
 const nodes=[{id:'video',type:'video',metadata:{}},...names.map(id=>({id,title:id,type:'image',metadata:{storageKey:'image:'+id,status:'success'}}))];
 const connections=names.map(id=>({fromNodeId:id,toNodeId:'video'}));
 const context=buildNodeGenerationContext('video',nodes,connections,'原文');
 assert.equal(context.imageCount,6);assert.equal(context.prompt,'原文');
 assert.deepEqual(Array.from(context.referenceImages,image=>image.storageKey),names.map(id=>'image:'+id));
});
test('missing original image fails before a paid request',async()=>{
 const {api,config,calls}=fixture(()=>{throw Error('Must not send');});
 await assert.rejects(()=>api.createVideoGenerationTask(config,'scene',[{dataUrl:''}]),/原文件尚未读取成功/);
 assert.equal(calls.length,0);
});


test('media channel survives normalization and uses versioned media routes',()=>{
 const {config}=fixture(()=>{},undefined,'media');
 assert.equal(settings.normalizeLocalChannels(config)[0].videoApiMode,'media');
 const {localVideoGatewayUrl:route}=load('lib/local-video-gateway.ts');
 for(const suffix of ['models','videos','videos/task-123','videos/task-123/content']) assert.equal(route(settings.buildApiUrl('https://api.laogou.org','/media/'+suffix)),'/api/ai/laogou/v1/media/'+suffix);
});
test('media create, queued poll, completed download and local persistence form one paid job',async()=>{
 let poll=0, downloaded=0;
 const {api,config,calls}=fixture(()=>({data:{task_id:'upstream-task',status:'queued',downloadable:false}}), (url,options)=>{
  if(url.endsWith('/content')){downloaded++;assert.equal(options.responseType,'blob');assert.equal(options.headers.Authorization,'Bearer test-only');return {data:new Blob(['valid-video-fixture'],{type:'video/mp4'})};}
  return {data:{task_id:'upstream-task',status:++poll===1?'running':'succeeded',downloadable:poll>1}};
 },'media');
 const refs=Array.from({length:6},(_,i)=>({dataUrl:'data:image/png;base64,'+i}));
 const created=await api.createVideoGenerationTask(config,'原始提示词',refs);
 const [url,body,options]=calls[0];
 assert.equal(url,'/api/ai/laogou/v1/media/videos');assert.equal(body.duration,30);assert.equal(body.resolution,'720p');assert.equal(body.ratio,'16:9');assert.equal(body.image_urls.length,6);assert.equal(body.prompt,'原始提示词');assert.ok(!('duration_seconds' in body));assert.match(options.headers['Idempotency-Key'],/^[0-9a-f-]{36}$/);
 assert.equal(created.task.id,'upstream-task');
 const running=await api.pollVideoGenerationTaskStatus(config,created.task);assert.equal(running.status,'running');assert.equal(downloaded,0);
 const completed=await api.pollVideoGenerationTaskStatus(config,running);assert.equal(completed.storageKey,'video:stored');assert.equal(completed.url,'blob:stored-video');assert.equal(downloaded,1);
 assert.equal(calls.filter(([u])=>u==='/api/ai/laogou/v1/media/videos').length,1);
});
test('media rejected requests preserve idempotency and never retry automatically',async()=>{
 const {api,config,calls}=fixture(()=>{throw {isAxiosError:true,response:{status:400,data:{error:{message:'image not allowed'}}}};},undefined,'media');
 await assert.rejects(()=>api.createVideoGenerationTask(config,'scene'),error=>{assert.match(error.detail,/idempotencyKey/);assert.match(error.message,/image not allowed/);return true;});
 assert.equal(calls.length,1);
});

test('media failure preserves the provider portrait restriction',async()=>{
 const {api,config}=fixture(()=>{},()=>({data:{task_id:'failed-task',status:'failed',error:'图片未通过肖像保护（积分已退回）'}}),'media');
 const task=await api.pollVideoGenerationTaskStatus(config,{id:'failed-task'});
 assert.equal(task.status,'failed');assert.equal(task.error.message,'图片未通过肖像保护（积分已退回）');
});
