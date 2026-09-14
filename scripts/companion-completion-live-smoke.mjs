import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { sendCompanion } from '../companion-bridge.mjs';

const binary = process.env.COMPANION_BINARY;
assert.ok(binary, 'Set COMPANION_BINARY to the built native companion');
const fixture = await mkdtemp('/tmp/taskplan-completion-live-');
const socket = join(fixture, 'control.sock');
const detectedHost = execFileSync('/usr/bin/swift', ['-e',
  'import AppKit; print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "com.apple.loginwindow")'],
  { encoding: 'utf8' }).trim();
const hostBundle = process.env.COMPLETION_HOST_BUNDLE ?? detectedHost;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(predicate) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await delay(40);
  }
  throw new Error('Timed out waiting for completed-plan interaction');
}

const app = spawn(binary, [], { env: { ...process.env,
  PLAN_COMPANION_DATA: fixture, PLAN_COMPANION_SOCKET: socket, PLAN_COMPANION_HOST: hostBundle,
  PLAN_COMPANION_RETENTION_SECONDS: '15' }, stdio: ['ignore', 'pipe', 'pipe'] });
app.stderr.on('data', data => process.stderr.write(data));

try {
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).ok);
  await sendCompanion(socket, { action: 'upsert', plan: {
    id: 'completed-hover', title: 'Проверка hover-удаления', revision: 1, status: 'completed',
    completedAt: new Date(Date.now() - 1000).toISOString(),
    steps: [{ id: 'done', title: 'Готово', status: 'completed' }]
  }});
  await sendCompanion(socket, { action: 'set_frame', x: 500, y: 300, width: 420, height: 430 });
  const state = await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    return current.visible && current.planCount === 1 && current;
  });
  assert.equal(state.window.completedPlanHoverAction, 'blurred-x-immediate-remove');
  const iconX = state.window.x + 24;
  const iconY = state.window.y + state.window.height - 24;
  spawn('/usr/bin/swift', ['-e', `
import AppKit
import CoreGraphics
import Darwin
let old = CGEvent(source: nil)!.location
let screenTop = NSScreen.screens.first!.frame.maxY
let point = CGPoint(x: ${iconX}, y: screenTop - ${iconY})
CGWarpMouseCursorPosition(point)
usleep(1500000)
CGWarpMouseCursorPosition(old)
`], { stdio: ['ignore', 'pipe', 'pipe'] });
  await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    if (current.hoveredPlanID === 'completed-hover') {
      await delay(240);
      await sendCompanion(socket, { action: 'snapshot', name: 'hover-cross' });
      return true;
    }
    return false;
  });
  const clicked = await sendCompanion(socket, {
    action: 'completion_click_probe', x: 24, y: state.window.height - 24
  });
  assert.equal(clicked.removed, true, 'completed icon hit-test must remove the plan immediately');
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).state.planCount === 0);
  const final = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(final.selected, null);
  assert.equal(final.visible, false);
  console.log(JSON.stringify({ passed: true, fixture, snapshot: join(fixture, 'hover-cross.png') }));
} finally {
  if (app.exitCode === null) {
    try { await sendCompanion(socket, { action: 'quit' }); } catch { app.kill('SIGKILL'); }
  }
}
