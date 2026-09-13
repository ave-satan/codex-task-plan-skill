import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { sendCompanion } from '../companion-bridge.mjs';

const binary = process.env.COMPANION_BINARY;
assert.ok(binary, 'Set COMPANION_BINARY to the built native companion');
const fixture = await mkdtemp('/tmp/taskplan-live-animation-');
const socket = join(fixture, 'control.sock');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(predicate) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await delay(40);
  }
  throw new Error('Timed out waiting for animation fixture');
}

async function frameHashes(prefix, durationMs, intervalMs) {
  const hashes = new Set();
  const count = Math.ceil(durationMs / intervalMs);
  for (let index = 0; index < count; index++) {
    const name = `${prefix}-${index}`;
    await sendCompanion(socket, { action: 'snapshot', name });
    const bytes = await readFile(join(fixture, `${name}.png`));
    hashes.add(createHash('sha256').update(bytes).digest('hex'));
    await delay(intervalMs);
  }
  return hashes;
}

const app = spawn(binary, [], { env: { ...process.env,
  PLAN_COMPANION_DATA: fixture, PLAN_COMPANION_SOCKET: socket, PLAN_COMPANION_HOST: 'com.openai.codex' },
  stdio: ['ignore', 'pipe', 'pipe'] });

try {
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).ok);
  await sendCompanion(socket, { action: 'upsert', plan: {
    id: 'animation-plan', title: 'Проверка анимаций', revision: 1, status: 'active',
    steps: [{ id: 'pending', title: 'Ожидающий шаг', status: 'pending' }]
  }});
  const pending = await frameHashes('pending', 6500, 100);
  assert.ok(pending.size >= 4, `Pending dots did not visibly animate: ${pending.size} unique frames`);

  await sendCompanion(socket, { action: 'upsert', plan: {
    id: 'animation-plan', title: 'Проверка анимаций', revision: 2, status: 'active',
    steps: [{ id: 'question', title: 'Нужен ответ пользователя', status: 'waiting_for_user',
      note: 'Продолжать с вариантом A?' }]
  }});
  const question = await frameHashes('question', 3200, 80);
  assert.ok(question.size >= 4, `Question icon did not visibly animate: ${question.size} unique frames`);

  await sendCompanion(socket, { action: 'upsert', plan: {
    id: 'animation-plan', title: 'Проверка анимаций', revision: 3, status: 'active',
    steps: [{ id: 'note', title: 'Статичный шаг', status: 'blocked', note: 'Новая подсказка' }]
  }});
  const noteInsert = await frameHashes('note-insert', 520, 40);
  assert.ok(noteInsert.size >= 3, `New note did not visibly animate: ${noteInsert.size} unique frames`);

  await sendCompanion(socket, { action: 'upsert', plan: {
    id: 'animation-plan', title: 'Проверка анимаций', revision: 4, status: 'active',
    steps: [{ id: 'note', title: 'Статичный шаг', status: 'blocked', note: 'Изменённая подсказка' }]
  }});
  const noteChange = await frameHashes('note-change', 520, 40);
  assert.ok(noteChange.size >= 3, `Changed note did not visibly animate: ${noteChange.size} unique frames`);

  await sendCompanion(socket, { action: 'upsert', plan: {
    id: 'animation-plan', title: 'Проверка анимаций', revision: 5, status: 'completed',
    completedAt: new Date().toISOString(),
    steps: [{ id: 'completed', title: 'Завершённый шаг', status: 'completed',
      agents: [{ name: 'worker', category: 'design', status: 'completed' }] }]
  }});
  const completed = await frameHashes('completed', 3800, 80);
  assert.ok(completed.size >= 4, `Completed agent check did not visibly animate: ${completed.size} unique frames`);
  console.log(JSON.stringify({ passed: true, fixture,
    pendingUniqueFrames: pending.size, questionUniqueFrames: question.size, noteInsertUniqueFrames: noteInsert.size,
    noteChangeUniqueFrames: noteChange.size, completedCheckUniqueFrames: completed.size }));
} finally {
  if (app.exitCode === null) {
    try { await sendCompanion(socket, { action: 'quit' }); } catch { app.kill('SIGKILL'); }
  }
}
