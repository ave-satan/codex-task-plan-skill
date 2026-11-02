import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = new URL('../', import.meta.url).pathname;
const fixture = await mkdtemp(join(tmpdir(), 'task-plan-chat-panel-'));
const database = join(fixture, 'plans.sqlite');
const chatA = randomUUID(), chatB = randomUUID(), emptyChat = randomUUID();
async function connect() {
  const client = new Client({ name: 'chat-panel-isolation', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server.mjs')], cwd: root,
    env: { ...process.env, TASK_PLAN_DB: database, CODEX_SQLITE_HOME: fixture, CODEX_THREAD_ID: chatA,
      TASK_PLAN_PRESENTATION: 'panel', TASK_PLAN_COMPANION_SOCKET: join(fixture, 'must-not-launch.sock'), TASK_PLAN_COMPANION_AUTOSTART: '1' } }));
  return client;
}
let client = await connect();
let writer = await connect();
async function raw(name, args = {}, thread = chatA, target = client, metadata) {
  return target.callTool({ name, arguments: args,
    ...(thread || metadata ? { _meta: metadata ?? { thread_id: thread, threadId: thread } } : {}) });
}
async function call(name, args = {}, thread = chatA, target = client) {
  const response = await raw(name, args, thread, target);
  assert.ok(!response.isError, JSON.stringify(response));
  return response.structuredContent;
}
const read = (thread = chatA) => call('get_chat_task_plan', {}, thread);
try {
  const tools = (await client.listTools()).tools;
  const entry = tools.find(tool => tool.name === 'open_task_plan_panel');
  assert.deepEqual(entry._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
  assert.equal(entry._meta['openai/ui'].preferredModelDisplayMode, 'fullscreen');
  assert.deepEqual(tools.find(tool => tool.name === 'get_chat_task_plan')._meta.ui.visibility, ['app']);
  assert.ok(!tools.find(tool => tool.name === 'show_task_plan')._meta?.ui?.resourceUri, 'Panel mode must not render repeated inline cards');

  const a = await call('create_task_plan', { title: 'Chat A private plan', steps: ['A first', 'A second'], thread_id: chatA });
  const b = await call('create_task_plan', { title: 'Chat B private plan', steps: ['B first', 'B second'] }, chatB);
  assert.equal((await read(chatA)).plan.id, a.plan_id);
  assert.equal((await read(chatB)).plan.id, b.plan_id);
  assert.equal((await read(emptyChat)).plan, null);
  assert.equal((await read(null)).plan, null, 'A shared process env must never select a chat');
  assert.equal((await read(null)).thread_id, null);
  for (const metadata of [{ thread_id: chatA, threadId: chatB }, { thread_id: 'invalid' }, { thread_id: chatA, threadId: null }]) {
    const result = await raw('get_chat_task_plan', {}, null, client, metadata);
    assert.equal(result.structuredContent.plan, null);
    assert.equal(result.structuredContent.thread_id, null);
  }
  assert.equal((await call('get_chat_task_plan', { thread_id: chatB }, chatA)).plan.id, a.plan_id, 'UI arguments cannot select another chat');
  assert.equal((await raw('create_task_plan', { title: 'Mismatched binding', steps: ['One', 'Two'], thread_id: chatB })).isError, true);
  assert.equal((await raw('get_task_plan', { plan_id: a.plan_id, thread_id: chatB }, chatB)).isError, true);

  const before = await read(chatA);
  assert.deepEqual((await read(chatA)).storeVersion, before.storeVersion, 'Repeated reads must not advance the snapshot version');
  await call('update_task_plan_step', { plan_id: a.plan_id, step_id: 'step-1', status: 'in_progress', note: 'Updated from a separate MCP writer' }, chatA, writer);
  const changed = await read(chatA);
  assert.equal(changed.plan.steps[0].note, 'Updated from a separate MCP writer');
  assert.ok(changed.storeVersion.revision > before.storeVersion.revision);
  const bState = await read(chatB);
  assert.equal(bState.plan.id, b.plan_id);
  assert.equal(bState.plan.steps[0].note, '');
  const scored = await call('record_task_plan_output', { plan_id: a.plan_id, points: 3 });
  assert.equal(scored.should_show, false);

  const child = await call('create_task_plan', { title: 'A child', steps: ['Child one', 'Child two'], parent_plan_id: a.plan_id, parent_step_id: 'step-2' });
  assert.equal((await read(chatA)).plan.id, a.plan_id, 'A linked subplan must not replace its root in the panel');
  await call('update_task_plan_step', { plan_id: child.plan_id, step_id: 'step-1', status: 'completed' });
  assert.equal((await read(chatA)).plan.steps[1].childPlans[0].id, child.plan_id);
  assert.equal((await raw('create_task_plan', { title: 'Wrong parent', steps: ['One', 'Two'], parent_plan_id: b.plan_id, parent_step_id: 'step-1' })).isError, true);

  assert.equal((await raw('ack_task_plan_panel', { instance_id: 'wrong', plan_id: b.plan_id, revision: 1, counter: '0 из 2' })).isError, true);
  await call('ack_task_plan_panel', { instance_id: 'fixture-ui-only', plan_id: a.plan_id, revision: changed.plan.revision, counter: '0 из 2' });
  assert.equal((await call('get_task_plan_panel_status')).receipts.length, 1);
  assert.deepEqual((await call('get_task_plan_panel_status', {}, chatB)).receipts, []);

  const latest = await call('create_task_plan', { title: 'New A task', steps: ['Newest one', 'Newest two'] });
  assert.equal((await read()).plan.id, latest.plan_id);
  await call('update_task_plan_step', { plan_id: latest.plan_id, step_id: 'step-1', status: 'completed' });
  await call('update_task_plan_step', { plan_id: latest.plan_id, step_id: 'step-2', status: 'completed' });
  assert.equal((await read()).plan.status, 'completed');
  const db = new DatabaseSync(database);
  const row = db.prepare('SELECT data FROM plans WHERE id=?').get(latest.plan_id);
  const expired = { ...JSON.parse(row.data), completedAt: new Date(Date.now() - 31_000).toISOString() };
  db.prepare('UPDATE plans SET data=? WHERE id=?').run(JSON.stringify(expired), latest.plan_id);
  assert.equal((await read()).plan, null, 'Do not revive an older active plan after the newest plan expires');
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='companion_outbox'").get().n, 0);
  // Legacy roots used goalLink.threadId, without a separate owner field.
  const legacyB = JSON.parse(db.prepare('SELECT data FROM plans WHERE id=?').get(b.plan_id).data);
  delete legacyB.threadId;
  legacyB.goalLink = { threadId: chatB, expectedObjective: legacyB.title, goalId: null, state: 'waiting' };
  db.prepare('UPDATE plans SET data=? WHERE id=?').run(JSON.stringify(legacyB), b.plan_id);
  db.close();
  assert.equal((await read(chatB)).plan.id, b.plan_id);
  const persisted = await read(chatB);
  await client.close(); client = await connect();
  assert.equal((await read(chatB)).plan.id, b.plan_id);
  assert.deepEqual((await read(chatB)).storeVersion, persisted.storeVersion);

  const unbound = await call('create_task_plan', { title: 'Unbound legacy fixture', steps: ['One', 'Two'] }, null);
  assert.equal((await raw('get_task_plan', { plan_id: unbound.plan_id, thread_id: chatB }, chatA)).isError, true,
    'A host chat cannot bind an unbound plan to another chat through read arguments');
  assert.equal((await read(chatB)).plan.id, b.plan_id);
  await call('get_task_plan', { plan_id: unbound.plan_id, thread_id: chatA });
  assert.equal((await read(chatA)).plan.id, unbound.plan_id);

  const resource = await client.readResource({ uri: entry._meta.ui.resourceUri });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(!resource.contents[0].text.includes('/*__PANEL_BRIDGE__*/'));
  assert.ok(!resource.contents[0].text.includes('/*__WORK_CATEGORY_ICONS__*/'));
  console.log(JSON.stringify({ passed: true, fixture, checks: ['host-derived chat isolation', 'unknown and conflicting chat identities', 'external writer visibility',
    'linked subplans', 'latest-plan selection and expiry', 'legacy ownership and restart persistence', 'chat-scoped receipts', 'no companion or repeated inline cards'] }, null, 2));
} finally { await Promise.allSettled([client.close(), writer.close()]); }
