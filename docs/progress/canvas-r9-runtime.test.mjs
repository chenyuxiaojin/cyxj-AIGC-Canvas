// Execute the real generator's early-failure paths without a provider or canvas writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = requireWeb('typescript');
const source = readFileSync(new URL('../../web/src/app/(user)/canvas/[id]/canvas-client-page.tsx', import.meta.url), 'utf8');
const start = source.indexOf('    const executeGenerateNode = useCallback(');
const end = source.indexOf('\n    const ', start);
assert.ok(start > 0 && end > start);
const code = ts.transpileModule(source.slice(start, end) + '\nexports.run = executeGenerateNode;', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function harness({ready = true, hydrationError, prompt = '测试'} = {}) {
    const changes = [], dialogs = [];
    const context = { exports: {}, useCallback: (fn) => fn,
        effectiveConfig: {}, openConfigDialog: (value) => dialogs.push(value),
        connectionsRef: {current: []},
        nodesRef: {current: [{id: 'node', type: 'text', metadata: {}}]},
        buildGenerationConfig: () => ({model: 'test-only'}), isAiConfigReady: () => ready,
        CanvasNodeType: {Text: 'text', Config: 'config'}, setRunningNodeId: (id) => changes.push(id),
        buildNodeGenerationContext: () => ({}),
        hydrateNodeGenerationContext: async () => {if(hydrationError) throw hydrationError; return {prompt};},
        isCanvasImageNodeType: () => false,
    };
    vm.runInNewContext(code, context);
    return { run: () => context.exports.run('node', 'text', prompt), changes, dialogs };
}
test('failed reference hydration does not leave the generator permanently busy', async () => {
    const failure = new Error('original reference is missing');
    const h = harness({hydrationError: failure});
    await assert.rejects(h.run(), (error) => error === failure);
    assert.deepEqual(h.changes, []);
});
test('empty text input cannot be reported as a completed generation or acquire the busy flag', async () => {
    const h = harness({prompt: ''});
    await assert.rejects(h.run(), /请先填写生成内容/);
    assert.deepEqual(h.changes, []);
});
test('missing model configuration opens configuration without starting work', async () => {
    const h = harness({ready: false});
    await h.run();
    assert.deepEqual(h.dialogs, [true]);
    assert.deepEqual(h.changes, []);
});

const directorBridge = readFileSync(new URL('../../web/public/director/agent-bridge.js', import.meta.url), 'utf8').replace(/^import .*;\n/, '');
function directorHarness() {
    const messages = [], calls = [];
    let receive;
    const parent = {postMessage: (value) => messages.push(value)};
    const state = {project: {cameras: [{id: 'cam'}], activeCameraId: 'cam', timeline: {durationSeconds: 1}}, setViewMode: () => {}, setTimelineTime: () => {}, setActiveCamera: () => {}};
    const context = {location: {origin: 'http://canvas.test'}, parent, window: {addEventListener: (_, fn) => {receive = fn;}},
        directorAgentReady: () => true, directorStore: {getState: () => state}, requestAnimationFrame: (fn) => fn(),
        captureDirector: async (args) => {calls.push(args); return [{dataUrl: 'data:image/png;base64,fixture', label: '当前机位'}];},
        directorAgentExportVideo: async () => ({blob: {size: 42}, fileName: 'shot.mp4'}),
    };
    vm.runInNewContext(directorBridge, context);
    return {messages, calls, send: (data, origin = context.location.origin, source = parent) => receive({origin, source, data})};
}
test('director bridge ignores foreign windows and correlates actual capture outputs with request ids', async () => {
    const h = directorHarness();
    const data = {type: 'storyai:director-command', requestId: 'capture-one', action: 'director_capture', arguments: {preset: 'four'}};
    await h.send(data, 'http://foreign.test'); await h.send(data, 'http://canvas.test', {});
    assert.equal(h.calls.length, 0);
    await h.send(data);
    assert.equal(h.calls[0].preset, 'four');
    assert.equal(h.messages[0].requestId, 'capture-one');
    assert.equal(h.messages[0].payload.captures[0].label, '当前机位');
});
test('director invalid camera or timeline rejects without calling renderer and export returns original payload', async () => {
    const h = directorHarness();
    for (const args of [{cameraId: 'missing'}, {seconds: 9}]) {
        await h.send({type: 'storyai:director-command', requestId: 'invalid', action: 'director_capture', arguments: args});
        assert.equal(h.messages.at(-1).payload.ok, false);
    }
    assert.equal(h.calls.length, 0);
    await h.send({type: 'storyai:director-command', requestId: 'video', action: 'director_export_video'});
    assert.equal(h.messages.at(-1).payload.video.fileName, 'shot.mp4');
});

const directorBundle = readFileSync(new URL('../../web/public/director/assets/index-oQuo7db8.js', import.meta.url), 'utf8');
const recorderCode = directorBundle.slice(directorBundle.indexOf('async function KB('), directorBundle.indexOf('var ZB=', directorBundle.indexOf('async function KB('))) + '; exports.record = KB;';
test('director timeline waits for asynchronous encoder start and releases tracks after recording', async () => {
    const frames = [];
    let clock = 0, started = false, stopped = false, recorder;
    class Recorder extends EventTarget {
        state = 'inactive';
        constructor() {super(); recorder = this;}
        start() {this.state = 'recording';}
        stop() {this.state = 'inactive'; const event = new Event('dataavailable'); event.data = new Blob(['video'], {type: 'video/mp4'}); this.dispatchEvent(event); this.dispatchEvent(new Event('stop'));}
    }
    const context = {exports: {}, Blob, MediaRecorder: Recorder, qB: () => 'video/mp4', ia: 25, rR: 1e6,
        setTimeout, clearTimeout, performance: {now: () => clock},
        requestAnimationFrame: (callback) => setImmediate(() => {clock += 40; if (clock >= 120 && !started) {started = true; recorder.dispatchEvent(new Event('start'));} callback(clock);}),
    };
    vm.runInNewContext(recorderCode, context);
    const blob = await context.exports.record({canvas: {captureStream: () => ({getTracks: () => [{stop: () => {stopped = true;}}]})}, durationSeconds: 1, renderFrame: (seconds) => frames.push({seconds,started})});
    assert.ok(frames.filter((f) => !f.started).every((f) => f.seconds === 0));
    assert.ok(frames.some((f) => f.seconds === 1));
    assert.equal(blob.size, 5);
    assert.equal(stopped, true);
});
