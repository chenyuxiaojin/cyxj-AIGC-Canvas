import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const ts = createRequire(new URL('../../web/package.json', import.meta.url))('typescript');
const source = readFileSync(new URL('../../web/src/services/desktop-terminal.ts', import.meta.url), 'utf8');
function harness(options = {}) {
    const calls = [], controller = new AbortController();
    const module = { exports: {} };
    const invoke = async (name, args) => {
        calls.push({ name, args });
        if (name === 'inspect_canvas_project_bindings') return [{ projectId: 'film', state: options.state || 'unbound', message: '绑定失效' }];
        if (name === 'select_film_directory') {
            if (options.abort) controller.abort();
            return options.cancel ? null : '/selected/片子';
        }
        if (options.fail) throw new Error('目录已绑定其他画布');
        return { configured: !options.unconfigured, configurationError: '配置失败' };
    };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, require: () => ({ invoke, isTauri: () => true }), Map, Error });
    return { calls, run: () => module.exports.ensureCanvasAgentWorkspace('film', '面包喵', controller.signal) };
}
test('unbound chat selects and binds the exact canvas before continuing', async () => {
    const h = harness(); assert.equal(await h.run(), true);
    assert.deepEqual(h.calls.map(c => c.name), ['inspect_canvas_project_bindings', 'select_film_directory', 'bind_canvas_project_directory']);
    assert.equal(h.calls[2].args.projectId, 'film'); assert.equal(h.calls[2].args.projectDirectory, '/selected/片子');
});
test('existing binding continues without a picker', async () => {
    const h = harness({ state: 'bound' }); assert.equal(await h.run(), true);
    assert.deepEqual(h.calls.map(c => c.name), ['inspect_canvas_project_bindings', 'resolve_canvas_project_workspace']);
});
test('cancel does not bind or start an Agent', async () => {
    const h = harness({ cancel: true }); assert.equal(await h.run(), false); assert.equal(h.calls.length, 2);
});
test('stop while picker is open prevents later binding', async () => {
    const h = harness({ abort: true }); await assert.rejects(h.run(), { name: 'AbortError' }); assert.equal(h.calls.length, 2);
});
test('invalid and duplicate bindings are not replaced', async () => {
    for (const state of ['invalid', 'duplicate']) { const h = harness({ state }); await assert.rejects(h.run(), /绑定失效/); assert.equal(h.calls.length, 1); }
});
test('binding conflict and setup failure cannot proceed', async () => {
    await assert.rejects(harness({ fail: true }).run(), /目录已绑定其他画布/);
    await assert.rejects(harness({ unconfigured: true }).run(), /配置失败/);
});
