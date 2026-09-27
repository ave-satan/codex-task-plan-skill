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

function pointerScript(appKitX, appKitY, clickAppKitX = null, awayAppKitX = null, staleAppKitY = null,
  trayGapAppKitX = null, trayEdgeAppKitX = null) {
  return `
import AppKit
import CoreGraphics
import Darwin
let old = CGEvent(source: nil)!.location
let screenTop = NSScreen.screens.first!.frame.maxY
func cgPoint(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: screenTop - y) }
${staleAppKitY === null ? '' : `
CGWarpMouseCursorPosition(cgPoint(${appKitX}, ${staleAppKitY}))
print("STALE_HOVER"); fflush(stdout)
usleep(800000)
`}
CGWarpMouseCursorPosition(cgPoint(${appKitX}, ${appKitY}))
print("ACTIVE_HOVER"); fflush(stdout)
usleep(120000)
print("EARLY"); fflush(stdout)
usleep(320000)
print("REVEAL_READY"); fflush(stdout)
usleep(700000)
${trayGapAppKitX === null ? '' : `
CGWarpMouseCursorPosition(cgPoint(${trayGapAppKitX}, ${appKitY}))
print("TRAY_GAP"); fflush(stdout)
usleep(600000)
CGWarpMouseCursorPosition(cgPoint(${trayEdgeAppKitX}, ${appKitY}))
print("TRAY_EDGE"); fflush(stdout)
usleep(600000)
`}
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
usleep(450000)
`}
${trayGapAppKitX === null ? '' : `
CGWarpMouseCursorPosition(cgPoint(${appKitX}, ${appKitY}))
print("REOPEN"); fflush(stdout)
_ = readLine()
`}
CGWarpMouseCursorPosition(old)
`;
}

const app = spawn(binary, [], { env: { ...process.env,
  PLAN_COMPANION_DATA: fixture, PLAN_COMPANION_SOCKET: socket, PLAN_COMPANION_HOST: hostBundle,
  PLAN_COMPANION_TEST_DISABLE_HOST_ATTACHMENT: '1' },
  stdio: ['ignore', 'pipe', 'pipe'] });
let mover;

try {
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).ok);
  for (const [index, title] of ['Проверка палитры Codex и поведения длинной подсказки', 'Второй эксперимент', 'Новая шапка планов с очень длинным названием для проверки положения иконки'].entries()) {
    await sendCompanion(socket, { action: 'upsert', plan: {
      id: `plan-${index + 1}`, title, revision: 1, status: 'active',
      steps: [{ id: 'one', title: 'Шаг', status: index === 2 ? 'in_progress' : 'pending', progress: 38 }]
    }});
  }
  await sendCompanion(socket, { action: 'set_frame', x: 500, y: 300, width: 320, height: 430 });
  const activator = spawn('/usr/bin/swift', ['-e', `
import AppKit
import Darwin
NSRunningApplication.runningApplications(withBundleIdentifier: "${hostBundle}").first?.activate()
usleep(500000)
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal((await once(activator, 'exit'))[0], 0);
  await sendCompanion(socket, { action: 'snapshot', name: 'pre-hover' });
  let lastHeaderState;
  const state = await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    lastHeaderState = current;
    return current.visible && current.window.planIconFrame
      && current.window.planIconFrame.y < current.window.y + current.window.height - 36 && current;
  }).catch(error => {
    console.error('header fixture', JSON.stringify({ visible: lastHeaderState?.visible,
      frame: lastHeaderState?.window?.planIconFrame, window: [lastHeaderState?.window?.x,
        lastHeaderState?.window?.y, lastHeaderState?.window?.width, lastHeaderState?.window?.height] }));
    throw error;
  });
  assert.equal(state.selected, 'plan-3');
  assert.equal(state.planSwitcherExpanded, false);
  await sendCompanion(socket, { action: 'snapshot', name: 'collapsed' });

  // A multiline title lowers the centered icon; hover and click must follow it.
  const iconX = state.window.planIconFrame.x + 12;
  const iconY = state.window.planIconFrame.y + 12;
  const firstAlternativeX = iconX + 28 + 8;
  const trayGapX = iconX + 18;
  const trayEdgeX = iconX + 80;
  const staleIconY = state.window.y + state.window.height - 24;
  mover = spawn('/usr/bin/swift', ['-e', pointerScript(iconX, iconY, firstAlternativeX, state.window.x + 220,
    staleIconY, trayGapX, trayEdgeX)],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const moverExit = once(mover, 'exit');
  let moverOutput = '';
  const signals = new Map();
  for (const name of ['STALE_HOVER', 'ACTIVE_HOVER', 'EARLY', 'REVEAL_READY', 'TRAY_GAP', 'TRAY_EDGE',
    'ALT_HOVER', 'LEAVE', 'EXIT_EARLY', 'EXIT_DONE', 'REOPEN']) {
    signals.set(name, {});
    signals.get(name).promise = new Promise(resolve => { signals.get(name).resolve = resolve; });
  }
  mover.stdout.on('data', chunk => {
    moverOutput += chunk;
    for (const [name, signal] of signals) if (moverOutput.includes(name)) signal.resolve();
  });

  await signals.get('STALE_HOVER').promise;
  await delay(120);
  const stale = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(stale.hoveredPlanID, null, 'old top-row hit zone must not activate hover');
  assert.equal(stale.planSwitcherExpanded, false);
  await signals.get('EARLY').promise;
  await eventually(async () => {
    const early = (await sendCompanion(socket, { action: 'status' })).state;
    return early.planSwitcherExpanded && early.hoveredPlanID === 'plan-3';
  });
  await signals.get('REVEAL_READY').promise;
  let lastExpandedState;
  await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    lastExpandedState = current;
    if (!current.planSwitcherExpanded) return false;
    await delay(400);
    await sendCompanion(socket, { action: 'snapshot', name: 'expanded' });
    return true;
  }).catch(error => {
    console.error('expanded fixture', JSON.stringify({ hovered: lastExpandedState?.hoveredPlanID,
      expanded: lastExpandedState?.planSwitcherExpanded,
      icon: lastExpandedState?.window?.planIconFrame,
      mouse: [lastExpandedState?.window?.mouseX, lastExpandedState?.window?.mouseY] }));
    throw error;
  });
  await signals.get('TRAY_GAP').promise;
  let lastGapState;
  await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    lastGapState = current;
    return current.planSwitcherExpanded && current.planSwitcherTrayExpanded
      && current.hoveredPlanID === null;
  }).catch(error => {
    console.error('gap fixture', JSON.stringify({ expanded: lastGapState?.planSwitcherExpanded,
      tray: lastGapState?.planSwitcherTrayExpanded, hovered: lastGapState?.hoveredPlanID,
      icon: lastGapState?.window?.planIconFrame,
      mouse: [lastGapState?.window?.mouseX, lastGapState?.window?.mouseY] }));
    throw error;
  });
  await sendCompanion(socket, { action: 'snapshot', name: 'tray-gap' });
  await signals.get('TRAY_EDGE').promise;
  await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    return current.planSwitcherExpanded && current.planSwitcherTrayExpanded
      && current.hoveredPlanID === null;
  });
  await sendCompanion(socket, { action: 'snapshot', name: 'tray-edge' });
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
  await signals.get('REOPEN').promise;
  await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    return current.planSwitcherExpanded && current.planSwitcherTrayExpanded
      && current.hoveredPlanID === 'plan-3';
  });
  const retracting = (await sendCompanion(socket, { action: 'test_animated_select', id: 'plan-1' })).state;
  assert.equal(retracting.switchingPlanID, 'plan-1');
  assert.equal(retracting.selected, 'plan-3', 'the old title starts fading while icons retract');
  assert.equal(retracting.titleAppearing, false, 'title animation starts with icon retraction');
  assert.equal(retracting.planSwitcherExpanded, false);
  assert.equal(retracting.planSwitcherTrayExpanded, true, 'the backdrop stays behind retracting icons');
  await delay(80);
  await sendCompanion(socket, { action: 'snapshot', name: 'retracting' });
  mover.stdin.end('\n');
  assert.equal((await moverExit)[0], 0);
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).state.selected === 'plan-1');
  await delay(100);
  await sendCompanion(socket, { action: 'snapshot', name: 'title-changing' });
  const final = await eventually(async () => {
    const current = (await sendCompanion(socket, { action: 'status' })).state;
    return current.switchingPlanID === null && current.titleAppearing && current;
  });
  assert.equal(final.planSwitcherExpanded, false);
  assert.equal(final.planSwitcherTrayExpanded, false);
  assert.equal(final.switchingPlanID, null);
  assert.equal(final.selected, 'plan-1');
  await sendCompanion(socket, { action: 'snapshot', name: 'selected' });
  assert.equal(final.visible, true, 'clicking the companion must not hide it');
  console.log(JSON.stringify({ passed: true, fixture, selected: final.selected }));
} finally {
  mover?.stdin?.end('\n');
  if (app.exitCode === null) {
    try { await sendCompanion(socket, { action: 'quit' }); } catch { app.kill('SIGKILL'); }
  }
}
