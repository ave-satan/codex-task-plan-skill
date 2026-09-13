import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { sendCompanion } from '../companion-bridge.mjs';

const binary = process.env.COMPANION_BINARY;
assert.ok(binary, 'Set COMPANION_BINARY to the built native companion');
const fixture = await mkdtemp('/tmp/taskplan-layout-');
const socket = join(fixture, 'control.sock');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await delay(40);
  }
  throw new Error('Timed out waiting for layout fixture');
}

const app = spawn(binary, [], { env: { ...process.env,
  PLAN_COMPANION_DATA: fixture, PLAN_COMPANION_SOCKET: socket, PLAN_COMPANION_HOST: 'com.openai.codex' },
  stdio: ['ignore', 'pipe', 'pipe'] });

try {
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).ok);
  await sendCompanion(socket, { action: 'upsert', plan: {
    id: 'narrow-layout', title: 'Доработать анимации и адаптивность очень узкого окна', revision: 1, status: 'active',
    steps: [
      { id: 'done-1', title: 'Смягчить палитру и анимировать подсказку', status: 'completed',
        note: 'Палитра приглушена; подсказка анимируется при появлении и изменении.' },
      { id: 'done-2', title: 'Переделать hover-ленту планов', status: 'completed',
        note: 'Лента раскрывается с задержкой, иконки выезжают, hover и выбор проверены.' },
      { id: 'done-3', title: 'Сделать адаптивный layout шага и иконок', status: 'completed',
        note: 'Длинный заголовок переносится, счётчик остаётся на baseline.' },
      { id: 'active', title: 'Сделать адаптивный заголовок шага с большим количеством агентов',
      status: 'in_progress', progress: 42, note: 'Подсказка остаётся целиком над нижней кромкой',
      agents: ['research','architecture','design','implementation','testing','review','operations']
        .map((category, index) => ({ name: `agent-${index}`, category, status: index > 4 ? 'completed' : 'working' })) },
      { id: 'pending', title: 'Проверить следующий шаг…', status: 'pending' }]
  }});
  await sendCompanion(socket, { action: 'set_frame', x: 500, y: 300, width: 280, height: 400 });
  await delay(450);
  const state = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(state.window.width, 280);
  assert.equal(state.window.minimumWidth, 280);
  assert.equal(state.window.agentOverflow, 'overlay-text-with-stronger-material-blur');
  assert.equal(state.window.agentStackTrigger, 'title-plus-icons-overflow-always-compacts');
  assert.equal(state.window.agentStackStrideScale, 0.42);
  assert.equal(state.window.agentBlurStrength, 'regular-material-plus-surface-fade');
  assert.equal(state.window.counterAlignment, 'title-baseline');
  await sendCompanion(socket, { action: 'snapshot', name: 'narrow-layout' });
  console.log(JSON.stringify({ passed: true, fixture, snapshot: join(fixture, 'narrow-layout.png') }));
} finally {
  if (app.exitCode === null) {
    try { await sendCompanion(socket, { action: 'quit' }); } catch { app.kill('SIGKILL'); }
  }
}
