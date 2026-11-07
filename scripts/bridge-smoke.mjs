import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const source = (await readFile(new URL('../panel-bridge.js', import.meta.url), 'utf8'))
  .replace('__TASK_PLAN_ARCHIVE__', 'false').replace('__PANEL_APP_CLASS__', 'FixtureApp');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function mount(mode) {
  const thread = randomUUID(), id = randomUUID();
  let current = { panel: true, thread_id: thread, plan: { id, revision: 1, status: 'active', steps: [] },
    storeVersion: { generation: randomUUID(), revision: 1 } };
  const calls = [], states = [], timers = new Map(), events = new Map();
  let app, timerId = 0, closed = 0;
  class FixtureApp {
    constructor() { app = this; }
    getHostContext() { return { displayMode: mode }; }
    async connect() {}
    async callServerTool(request) {
      calls.push(request);
      return request.name === 'get_chat_task_plan'
        ? { structuredContent: structuredClone(current) } : { structuredContent: { acknowledged: true } };
    }
    async requestTeardown() { closed++; }
    async sendSizeChanged(size) { calls.push({ name: 'size', size }); }
    async close() {}
  }
  const window = { parent: {}, addEventListener: (name, fn) => events.set(name, fn), dispatchEvent() {} };
  const document = { hidden: false, documentElement: { dataset: {} }, addEventListener: (name, fn) => events.set(name, fn) };
  const context = vm.createContext({ window, document, FixtureApp, crypto: { randomUUID }, Event,
    AbortController, queueMicrotask, requestAnimationFrame: fn => fn(),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) });
  await vm.runInContext(`(async () => { ${source}\n})()`, context);
  await flush();
  window.taskPlanPanel.onState(value => {
    states.push(structuredClone(value));
    window.taskPlanPanel.rendered({ plan_id: value.plan?.id, revision: value.plan?.revision, counter: 'fixture' });
  });
  await flush();
  return {
    calls, states, timers, app, events,
    get closed() { return closed; },
    setPlan(plan) { current = { ...current, plan, storeVersion: { ...current.storeVersion, revision: current.storeVersion.revision + 1 } }; },
    async tick() {
      const pending = [...timers.values()]; timers.clear();
      await Promise.all(pending.map(fn => fn())); await flush();
    },
  };
}
for (const mode of ['inline', 'fullscreen']) {
  const view = await mount(mode);
  assert.equal(view.states.at(-1).plan.status, 'active');
  assert.equal(view.closed, 0, 'An active tab stays open');
  const completed = { ...view.states.at(-1).plan, status: 'completed', revision: 2, finished: 2, total: 2 };
  view.setPlan(completed);
  await view.tick();
  assert.equal(view.states.at(-1).plan.status, 'completed');
  assert.equal(view.closed, 0, 'Completion does not close the tab');
  assert.equal(view.timers.size, 0, 'Completed views no longer poll live storage');
  assert.ok(view.calls.some(c => c.name === 'release_task_plan_panel'), 'Completed views release their live lease');
  assert.ok(view.calls.some(c => c.name === 'ack_task_plan_panel' && c.arguments.revision === 2));
  const reads = view.calls.filter(c => c.name === 'get_chat_task_plan').length;
  view.setPlan(null);
  await view.app.onhostcontextchanged(); await view.events.get('visibilitychange')(); await flush();
  view.app.ontoolresult({ structuredContent: { panel: true, thread_id: randomUUID(), plan: null } });
  assert.equal(view.states.at(-1).plan.status, 'completed', 'Cleanup cannot erase the mounted final snapshot');
  assert.equal(view.calls.filter(c => c.name === 'get_chat_task_plan').length, reads);
  assert.equal(view.closed, 0);
}
for (const mode of ['inline', 'fullscreen']) {
  const view = await mount(mode);
  view.setPlan(null); await view.tick();
  if (mode === 'inline') {
    assert.equal(view.states.at(-1).retired, true, 'Cancellation still collapses the live inline card');
    assert.ok(view.calls.some(c => c.name === 'size' && c.size.height === 1));
  } else assert.equal(view.closed, 1, 'Cancellation still closes an active tab');
}
console.log('Bridge lifecycle: completed inline and tab snapshots persist; cancellation still retires live views.');
