import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sendCompanion } from '../companion-bridge.mjs';

const fixture = await mkdtemp('/tmp/taskplan-retention-');
const socket = join(fixture, 'control.sock');
const binary = process.env.COMPANION_BINARY;
assert.ok(binary, 'Set COMPANION_BINARY to the built native companion');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    try { const result = await predicate(); if (result) return result; } catch {}
    await delay(25);
  }
  throw new Error('Retention condition timed out');
}

const app = spawn(binary, [], { env: { ...process.env,
  PLAN_COMPANION_DATA: fixture, PLAN_COMPANION_SOCKET: socket,
  PLAN_COMPANION_HOST: 'local.hidden.test', PLAN_COMPANION_RETENTION_SECONDS: '1.5' },
  stdio: ['ignore', 'pipe', 'pipe'] });
app.stderr.on('data', data => process.stderr.write(data));

try {
  await eventually(async () => (await sendCompanion(socket, {action:'status'})).ok);
  const completedAt = new Date().toISOString();
  await sendCompanion(socket, {action:'event', selectOnCreate:true, plan:{
    id:'expires', title:'Expires', revision:2, status:'completed', completedAt,
    source:'legacy-source', sourceRevision:1, creationSequence:1,
    steps:[{id:'one', title:'Done', status:'completed'}]
  }});
  const initial = (await sendCompanion(socket, {action:'status'})).state;
  assert.equal(initial.planCount, 1);
  assert.ok(initial.activeRetentionFraction > 0.8 && initial.activeRetentionFraction <= 1);
  await delay(280);
  const advanced = (await sendCompanion(socket, {action:'status'})).state;
  assert.ok(advanced.activeRetentionFraction < initial.activeRetentionFraction,
    'visual countdown must follow the real retention deadline');
  await eventually(async () => (await sendCompanion(socket, {action:'status'})).state.planCount === 0);
  await sendCompanion(socket, {action:'event', selectOnCreate:true, plan:{
    id:'expires', title:'Stale active replay', revision:1, status:'active',
    source:'retention-test', sourceRevision:1, creationSequence:1,
    steps:[{id:'one', title:'Again', status:'pending'}]
  }});
  assert.equal((await sendCompanion(socket, {action:'status'})).state.planCount, 0,
    'an old event must not resurrect an expired plan');
  await sendCompanion(socket, {action:'event', selectOnCreate:true, plan:{
    id:'already-expired', title:'Already expired', revision:3, status:'completed',
    completedAt:new Date(Date.now() - 10000).toISOString(),
    source:'retention-test', sourceRevision:3, creationSequence:3,
    steps:[{id:'one', title:'Done', status:'completed'}]
  }});
  assert.equal((await sendCompanion(socket, {action:'status'})).state.planCount, 0,
    'an already-expired terminal event must be pruned before ACK');
  const persisted = JSON.parse(await readFile(join(fixture, 'state.json'), 'utf8'));
  assert.deepEqual(persisted.plans, []);
  assert.equal(persisted.selected ?? null, null);
  assert.equal(persisted.deliveryWatermarks['already-expired'], 3);
  for (const [id, revision] of [['newer-delivery', 20], ['older-delivery', 10]]) {
    await sendCompanion(socket, {action:'event', selectOnCreate:false, plan:{
      id, title:id, revision, status:'active', source:'concurrent-source',
      steps:[{id:'one', title:'Ready', status:'pending'}]
    }});
  }
  assert.equal((await sendCompanion(socket, {action:'status'})).state.planCount, 2,
    'out-of-order delivery of distinct plans must not be discarded');
  console.log('Retention smoke passed: terminal plan expires from memory and persisted state.');
} finally {
  if (app.exitCode === null) {
    const exited = once(app, 'exit');
    try { await sendCompanion(socket, {action:'quit'}); await exited; } catch { app.kill('SIGKILL'); }
  }
}
