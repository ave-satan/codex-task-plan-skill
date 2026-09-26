import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sendCompanion } from '../companion-bridge.mjs';

const binary = process.env.COMPANION_BINARY;
assert.ok(binary, 'Set COMPANION_BINARY to the built native companion');
const hostBundle = process.env.CURSOR_HOST_BUNDLE ?? 'com.openai.codex';
const fixture = await mkdtemp('/tmp/taskplan-live-cursor-');
const socket = join(fixture, 'control.sock');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(read, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; } catch {}
    await delay(40);
  }
  throw new Error(`Timed out: ${message}`);
}

async function runSwift(source) {
  const child = spawn('/usr/bin/swift', ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  assert.equal((await once(child, 'exit'))[0], 0, stderr);
}

async function movePointer(point) {
  await runSwift(`
import AppKit
import CoreGraphics
import Darwin
let top = NSScreen.screens.map { $0.frame.maxY }.max()!
let position = CGPoint(x: ${point.x}, y: top - ${point.y})
CGWarpMouseCursorPosition(position)
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: position,
        mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(350000)
`);
}

const app = spawn(binary, [], { env: {
  ...process.env,
  PLAN_COMPANION_DATA: fixture,
  PLAN_COMPANION_SOCKET: socket,
  PLAN_COMPANION_HOST: hostBundle,
  PLAN_COMPANION_DISABLE_SPACE_ROUTING: '1',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let appStderr = '';
app.stderr.on('data', chunk => { appStderr += chunk; });

try {
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).ok,
    'companion startup').catch(error => {
      throw new Error(`${error.message}: stderr=${appStderr}, exit=${app.exitCode}, signal=${app.signalCode}`);
    });
  await sendCompanion(socket, { action: 'upsert', plan: {
    id: 'cursor-live', title: 'Cursor live', revision: 1, status: 'active',
    steps: [{ id: 'one', title: 'Hover edge', status: 'pending' }],
  }});
  await runSwift(`
import AppKit
import Darwin
NSRunningApplication.runningApplications(withBundleIdentifier: "${hostBundle}").first?
  .activate(options: [.activateIgnoringOtherApps])
usleep(600000)
`);
  await sendCompanion(socket, { action: 'set_frame', x: 500, y: 300, width: 420, height: 430 });
  await delay(700);
  const initial = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.visible && state.window.presentation === 'expanded' && state;
  }, `bring ${hostBundle} and the companion to the foreground`);
  assert.equal(initial.window.resizeCursorTracking,
    'explicit-7pt-edge-12pt-corner-nonactivating');
  assert.ok(initial.window.resizeCursorRectResets > 0,
    'non-key panel explicitly registers cursor rects on startup');
  if (process.env.CURSOR_EXPECT_INACTIVE_SPACE === '1') {
    assert.equal(initial.window.panelOnActiveSpace, false,
      'inactive-Space test needs a panel on another macOS Space');
    await movePointer({ x: initial.window.x + 2,
      y: initial.window.y + initial.window.height / 2 });
    const inactive = (await sendCompanion(socket, { action: 'status' })).state;
    assert.equal(inactive.window.liveResizeCursorKind, null,
      'a panel on another Space must not claim this pointer location');
    assert.notDeepEqual(inactive.window.systemCursorSize, { width: 30, height: 24 },
      'the hidden panel must not impose its horizontal resize cursor here');
    console.log('Inactive-Space cursor smoke passed: hidden panel does not override the foreground cursor.');
  } else {
  assert.equal(initial.window.panelOnActiveSpace, true,
    'visible cursor test must run on the same macOS Space as its panel');

  const midY = initial.window.y + initial.window.height / 2;
  await movePointer({ x: initial.window.x + 2, y: midY });
  const edge = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === 'left' && state;
  }, 'left resize cursor inside the 7pt edge');
  assert.equal(edge.frontmostBundle, hostBundle,
    'resize cursor hover must not activate the companion or flash Codex traffic lights');
  assert.equal(edge.window.resizeCursorActivatesApplication, false);
  assert.equal(edge.window.isKeyWindow, false, 'hover must keep the plan panel non-key');
  assert.equal(edge.window.applicationIsActive, false, 'hover must keep the companion inactive');
  assert.equal(edge.window.backgroundCursorUpdatesEnabled, true,
    'macOS must allow the nonactivating companion to set the visible cursor');
  assert.deepEqual(edge.window.systemCursorSize, edge.window.applicationCursorSize,
    'the displayed system cursor must be the resize cursor, not only the companion cursor');
  await movePointer({ x: initial.window.x + 9, y: midY });
  const inset = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === null && state;
  }, 'resize cursor clears beyond the reduced inner edge');
  assert.deepEqual(inset.window.systemCursorSize, inset.window.arrowCursorSize,
    'leaving the resize edge must restore the visible arrow');

  await movePointer({ x: initial.window.x - 2, y: midY });
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === null && state;
  }, 'resize cursor stays clear outside the window');

  await sendCompanion(socket, {
    action: 'set_frame',
    x: initial.window.x + 20,
    y: initial.window.y,
    width: initial.window.width - 20,
    height: initial.window.height,
  });
  const horizontal = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.x > initial.window.x + 10
      && state.window.width < initial.window.width - 10 && state;
  }, 'left-edge drag resizes the plan');
  assert.equal(horizontal.frontmostBundle, hostBundle);
  assert.ok(horizontal.window.resizeCursorRectResets > initial.window.resizeCursorRectResets,
    'resizing the non-key panel rebuilds cursor rects for the new frame');

  await sendCompanion(socket, {
    action: 'set_frame',
    x: horizontal.window.x,
    y: horizontal.window.y,
    width: horizontal.window.width,
    height: horizontal.window.height + 20,
  });
  const vertical = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.height > horizontal.window.height + 10 && state;
  }, 'top-edge drag resizes the plan vertically');
  await movePointer({ x: vertical.window.x + vertical.window.width / 2,
    y: vertical.window.y + vertical.window.height - 2 });
  const topEdge = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === 'top' && state;
  }, 'top resize cursor inside the 7pt edge');
  assert.deepEqual(topEdge.window.systemCursorSize, topEdge.window.applicationCursorSize,
    'top edge must show the vertical resize cursor');

  await movePointer({ x: vertical.window.x + 2,
    y: vertical.window.y + vertical.window.height - 2 });
  const corner = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === 'top-left' && state;
  }, 'corner resize cursor inside the 12pt corner');
  assert.deepEqual(corner.window.systemCursorSize, corner.window.applicationCursorSize,
    'corner must show the diagonal resize cursor');

  await movePointer({ x: 100, y: 100 });
  const finished = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === null && state;
  }, 'cursor clears after resize');
  assert.equal(finished.frontmostBundle, hostBundle);
  console.log('Live cursor smoke passed: visible resize cursors on side, top and corner without activating the companion.');
  }
} finally {
  if (app.exitCode === null) {
    try { await sendCompanion(socket, { action: 'quit' }); } catch { app.kill('SIGKILL'); }
  }
}
