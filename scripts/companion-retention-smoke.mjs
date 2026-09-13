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
  PLAN_COMPANION_HOST: 'local.hidden.test', PLAN_COMPANION_RETENTION_SECONDS: '0.25' },
  stdio: ['ignore', 'pipe', 'pipe'] });
app.stderr.on('data', data => process.stderr.write(data));

try {
  await eventually(async () => (await sendCompanion(socket, {action:'status'})).ok);
  const completedAt = new Date().toISOString();
  await sendCompanion(socket, {action:'event', selectOnCreate:true, plan:{
    id:'expires', title:'Expires', revision:1, status:'completed', completedAt,
    source:'retention-test', sourceRevision:1, creationSequence:1,
    steps:[{id:'one', title:'Done', status:'completed'}]
  }});
  assert.equal((await sendCompanion(socket, {action:'status'})).state.planCount, 1);
  await eventually(async () => (await sendCompanion(socket, {action:'status'})).state.planCount === 0);
  const persisted = JSON.parse(await readFile(join(fixture, 'state.json'), 'utf8'));
  assert.deepEqual(persisted.plans, []);
  assert.equal(persisted.selected ?? null, null);
  console.log('Retention smoke passed: terminal plan expires from memory and persisted state.');
} finally {
  if (app.exitCode === null) {
    const exited = once(app, 'exit');
    try { await sendCompanion(socket, {action:'quit'}); await exited; } catch { app.kill('SIGKILL'); }
  }
}
