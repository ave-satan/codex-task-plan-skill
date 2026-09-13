import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sendCompanion } from '../companion-bridge.mjs';

const binary = process.env.COMPANION_BINARY;
assert.ok(binary, 'Set COMPANION_BINARY to the built native companion');
const hostBundle = process.env.HEADER_HOST_BUNDLE ?? 'com.openai.codex';
const fixture = await mkdtemp('/tmp/taskplan-live-header-');
const socket = join(fixture, 'control.sock');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(predicate) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await delay(40);
  }
  throw new Error('Timed out waiting for live header state');
}

function pointerScript(appKitX, appKitY, clickAppKitX = null, awayAppKitX = null) {
  return `
import AppKit
import CoreGraphics
import Darwin
let old = CGEvent(source: nil)!.location
let screenTop = NSScreen.screens.first!.frame.maxY
func cgPoint(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: screenTop - y) }
CGWarpMouseCursorPosition(cgPoint(${appKitX}, ${appKitY}))
print("ACTIVE_HOVER"); fflush(stdout)
usleep(120000)
print("EARLY"); fflush(stdout)
usleep(320000)
print("REVEAL_READY"); fflush(stdout)
${clickAppKitX === null ? '' : `
CGWarpMouseCursorPosition(cgPoint(${clickAppKitX}, ${appKitY}))
print("ALT_HOVER"); fflush(stdout)
usleep(1500000)
CGWarpMouseCursorPosition(cgPoint(${awayAppKitX}, ${appKitY - 80}))
print("LEAVE"); fflush(stdout)
usleep(70000)
print("EXIT_EARLY"); fflush(stdout)
usleep(240000)
print("EXIT_DONE"); fflush(stdout)
`}
CGWarpMouseCursorPosition(old)
`;
}

const app = spawn(binary, [], { env: { ...process.env,
  PLAN_COMPANION_DATA: fixture, PLAN_COMPANION_SOCKET: socket, PLAN_COMPANION_HOST: hostBundle },
  stdio: ['ignore', 'pipe', 'pipe'] });

try {
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).ok);
  for (const [index, title] of ['Проверка палитры Codex и поведения длинной подсказки', 'Второй эксперимент', 'Новая шапка планов'].entries()) {
    await sendCompanion(socket, { action: 'upsert', plan: {
      id: `plan-${index + 1}`, title, revision: 1, status: 'active',
      steps: [{ id: 'one', title: 'Шаг', status: index === 2 ? 'in_progress' : 'pending', progress: 38 }]
    }});
  }
  await sendCompanion(socket, { action: 'set_frame', x: 500, y: 300, width: 420, height: 430 });
  const activator = spawn('/usr/bin/swift', ['-e', `
import AppKit
import Darwin
NSRunningApplication.runningApplications(withBundleIdentifier: "${hostBundle}").first?.activate()
usleep(500000)
`], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal((await once(activator, 'exit'))[0], 0);
  const state = await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    return current.visible && current;
  });
  assert.equal(state.selected, 'plan-3');
  assert.equal(state.planSwitcherExpanded, false);
  await sendCompanion(socket, { action: 'snapshot', name: 'collapsed' });

  // Header, status icons and text share the same 12/24/8 point grid.
  const iconX = state.window.x + 24;
  const iconY = state.window.y + state.window.height - 24;
  const firstAlternativeX = state.window.x + 52;
  const mover = spawn('/usr/bin/swift', ['-e', pointerScript(iconX, iconY, firstAlternativeX, state.window.x + 220)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const moverExit = once(mover, 'exit');
  let moverOutput = '';
  const signals = new Map();
  for (const name of ['ACTIVE_HOVER', 'EARLY', 'REVEAL_READY', 'ALT_HOVER', 'LEAVE', 'EXIT_EARLY', 'EXIT_DONE']) {
    signals.set(name, {});
    signals.get(name).promise = new Promise(resolve => { signals.get(name).resolve = resolve; });
  }
  mover.stdout.on('data', chunk => {
    moverOutput += chunk;
    for (const [name, signal] of signals) if (moverOutput.includes(name)) signal.resolve();
  });

  await signals.get('EARLY').promise;
  await eventually(async () => {
    const early = (await sendCompanion(socket, { action: 'status' })).state;
    return early.planSwitcherExpanded && early.hoveredPlanID === 'plan-3';
  });
  await signals.get('REVEAL_READY').promise;
  await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    if (!current.planSwitcherExpanded) return false;
    await delay(400);
    await sendCompanion(socket, { action: 'snapshot', name: 'expanded' });
    return true;
  });
  await signals.get('ALT_HOVER').promise;
  await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    if (current.hoveredPlanID !== 'plan-1' || !current.window.planTooltipVisible
        || current.window.planTooltipTitle !== 'Проверка палитры Codex и поведения длинной подсказки') return false;
    assert.ok(current.window.planTooltipFrame.width <= 240);
    assert.ok(current.window.planTooltipFrame.height > 29, 'long tooltip must word-wrap instead of truncating');
    await sendCompanion(socket, { action: 'snapshot', name: 'tooltip' });
    return true;
  });
  await signals.get('EXIT_EARLY').promise;
  await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    return !current.planSwitcherExpanded && current.hoveredPlanID === 'plan-1'
      && current.window.planHoverExitPending;
  });
  await signals.get('EXIT_DONE').promise;
  await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    return !current.planSwitcherExpanded && current.hoveredPlanID === null
      && !current.window.planHoverExitPending && !current.window.planTooltipVisible;
  });
  const [exitCode] = await moverExit;
  assert.equal(exitCode, 0);

  const clicker = spawn('/usr/bin/swift', ['-e', `
import AppKit
import CoreGraphics
import Darwin
let old = CGEvent(source: nil)!.location
let screenTop = NSScreen.screens.first!.frame.maxY
func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: screenTop - y) }
CGWarpMouseCursorPosition(point(${iconX}, ${iconY}))
usleep(300000)
let alternate = point(${firstAlternativeX}, ${iconY})
CGWarpMouseCursorPosition(alternate)
usleep(800000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: alternate, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(70000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: alternate, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(500000)
CGWarpMouseCursorPosition(old)
`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const clickerExit = once(clicker, 'exit');
  await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    if (current.hoveredPlanID === 'plan-1' && current.planSwitcherExpanded) return true;
    return false;
  });
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).state.selected === 'plan-1');
  assert.equal((await clickerExit)[0], 0);
  const final = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(final.planSwitcherExpanded, false);
  assert.equal(final.selected, 'plan-1');
  assert.equal(final.visible, true, 'clicking the companion must not hide it');
  assert.equal(final.frontmostBundle, hostBundle, 'clicking the nonactivating panel must preserve host focus');
  console.log(JSON.stringify({ passed: true, fixture, selected: final.selected }));
} finally {
  if (app.exitCode === null) {
    try { await sendCompanion(socket, { action: 'quit' }); } catch { app.kill('SIGKILL'); }
  }
}
