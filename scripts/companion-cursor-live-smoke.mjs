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
CGWarpMouseCursorPosition(CGPoint(x: ${point.x}, y: top - ${point.y}))
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

try {
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).ok,
    'companion startup');
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

  const midY = initial.window.y + initial.window.height / 2;
  await movePointer({ x: initial.window.x + 2, y: midY });
  const edge = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === 'left' && state;
  }, 'left resize cursor inside the 7pt edge');
  assert.equal(edge.frontmostBundle, hostBundle,
    'resize cursor hover must not activate the companion or flash Codex traffic lights');
  assert.equal(edge.window.resizeCursorActivatesApplication, false);

  await movePointer({ x: initial.window.x + 9, y: midY });
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === null && state;
  }, 'resize cursor clears beyond the reduced inner edge');

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

  await sendCompanion(socket, {
    action: 'set_frame',
    x: horizontal.window.x,
    y: horizontal.window.y,
    width: horizontal.window.width,
    height: horizontal.window.height + 20,
  });
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.height > horizontal.window.height + 10 && state;
  }, 'top-edge drag resizes the plan vertically');

  await movePointer({ x: 100, y: 100 });
  const finished = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === null && state;
  }, 'cursor clears after resize');
  assert.equal(finished.frontmostBundle, hostBundle);
  console.log('Live cursor smoke passed: reduced resize zone, constrained frame changes, and nonactivating hover.');
} finally {
  if (app.exitCode === null) {
    try { await sendCompanion(socket, { action: 'quit' }); } catch { app.kill('SIGKILL'); }
  }
}
