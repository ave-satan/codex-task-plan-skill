import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sendCompanion } from '../companion-bridge.mjs';

const binary = process.env.COMPANION_BINARY;
assert.ok(binary, 'Set COMPANION_BINARY to the built native companion');
const fixture = await mkdtemp('/tmp/taskplan-completed-collapsed-click-');
const socket = join(fixture, 'control.sock');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(predicate) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await delay(40);
  }
  throw new Error('Timed out waiting for collapsed completed-plan click');
}

const app = spawn(binary, [], { env: {
  ...process.env,
  PLAN_COMPANION_DATA: fixture,
  PLAN_COMPANION_SOCKET: socket,
  PLAN_COMPANION_HOST: 'local.taskplan.hidden-host',
  PLAN_COMPANION_RETENTION_SECONDS: '15',
}, stdio: ['ignore', 'pipe', 'pipe'] });

try {
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).ok);
  await sendCompanion(socket, { action: 'upsert', plan: {
    id: 'completed-collapsed-click', title: 'Удалить по крестику', revision: 1, status: 'completed',
    completedAt: new Date(Date.now() - 2000).toISOString(),
    steps: [{ id: 'done', title: 'Готово', status: 'completed' }],
  }});
  await sendCompanion(socket, { action: 'set_focus_collapse', enabled: true });
  const collapsed = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.presentation === 'collapsed' && !state.window.presentationTransitioning && state;
  });
  const iconX = collapsed.window.x + collapsed.window.width / 2;
  const iconY = collapsed.window.y + collapsed.window.height / 2;
  const clicker = spawn('/usr/bin/swift', ['-e', `
import AppKit
import CoreGraphics
import Darwin
let screenTop = NSScreen.screens.map { $0.frame.maxY }.max()!
let old = CGEvent(source: nil)!.location
let point = CGPoint(x: ${iconX}, y: screenTop - ${iconY})
CGWarpMouseCursorPosition(point)
usleep(220000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(90000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(350000)
CGWarpMouseCursorPosition(old)
`], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal((await once(clicker, 'exit'))[0], 0);
  const removed = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.planCount === 0 && state;
  });
  assert.equal(removed.visible, false);
  console.log(JSON.stringify({ passed: true, fixture }));
} finally {
  if (app.exitCode === null) {
    try { await sendCompanion(socket, { action: 'quit' }); } catch { app.kill('SIGKILL'); }
  }
}
