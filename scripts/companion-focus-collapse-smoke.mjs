import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sendCompanion } from '../companion-bridge.mjs';

const binary = process.env.COMPANION_BINARY;
assert.ok(binary, 'Set COMPANION_BINARY to the built native companion');
const hostBundle = process.env.FOCUS_HOST_BUNDLE ?? 'com.apple.finder';
const awayBundle = process.env.FOCUS_AWAY_BUNDLE ?? 'com.openai.codex';
const fixture = await mkdtemp('/tmp/taskplan-focus-collapse-');
const socket = join(fixture, 'control.sock');
const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(read, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; } catch {}
    await delay(50);
  }
  throw new Error(`Timed out: ${message}`);
}

async function runSwift(source) {
  const child = spawn('/usr/bin/swift', ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
}

async function activate(bundle) {
  await runSwift(`
import AppKit
import Darwin
NSRunningApplication.runningApplications(withBundleIdentifier: "${bundle}").first?.activate()
usleep(650000)
`);
}

async function drag(from, to) {
  await runSwift(`
import AppKit
import CoreGraphics
import Darwin
let screenTop = NSScreen.screens.map { $0.frame.maxY }.max()!
func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: screenTop - y) }
let start = point(${from.x}, ${from.y})
let finish = point(${to.x}, ${to.y})
CGWarpMouseCursorPosition(start)
usleep(120000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(70000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: finish, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(120000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: finish, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(450000)
`);
}

async function hover(point) {
  await runSwift(`
import AppKit
import CoreGraphics
import Darwin
let screenTop = NSScreen.screens.map { $0.frame.maxY }.max()!
CGWarpMouseCursorPosition(CGPoint(x: ${point.x}, y: screenTop - ${point.y}))
usleep(900000)
`);
}

async function movePointer(point) {
  await runSwift(`
import AppKit
import CoreGraphics
import Darwin
let screenTop = NSScreen.screens.map { $0.frame.maxY }.max()!
CGWarpMouseCursorPosition(CGPoint(x: ${point.x}, y: screenTop - ${point.y}))
usleep(180000)
`);
}

const app = spawn(binary, [], { env: { ...process.env,
  PLAN_COMPANION_DATA: fixture,
  PLAN_COMPANION_SOCKET: socket,
  PLAN_COMPANION_HOST: hostBundle,
  PLAN_COMPANION_FOCUS_COLLAPSE: '0',
  PLAN_COMPANION_RETENTION_SECONDS: '10',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let client;

try {
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).ok, 'companion startup');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'server.mjs')],
    cwd: root,
    env: { ...process.env, TASK_PLAN_DB: ':memory:', TASK_PLAN_COMPANION_SOCKET: socket },
  });
  client = new Client({ name: 'focus-collapse-smoke', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  const configured = await client.callTool({ name: 'set_companion_focus_mode', arguments: { enabled: true } });
  assert.equal(configured.structuredContent?.enabled, true);
  assert.equal(configured.structuredContent?.state?.window?.focusCollapseEnabled, true);
  for (const [id, title] of [['plan-1', 'Первый план'], ['plan-2', 'Второй план']]) {
    await sendCompanion(socket, { action: 'upsert', plan: {
      id, title, revision: 1, status: 'active',
      steps: [{ id: 'step-1', title: 'Проверить состояние', status: 'in_progress', progress: 35 }],
    }});
  }
  await sendCompanion(socket, { action: 'set_frame', x: 620, y: 260, width: 360, height: 360 });

  await activate(hostBundle);
  const expanded = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.visible && state.window.presentation === 'expanded'
      && Math.abs(state.window.width - 360) < 0.5 && state;
  }, 'expanded host window');
  assert.equal(expanded.window.width, 360);
  const expandedDragStart = {
    x: expanded.window.x + 120,
    y: expanded.window.y + expanded.window.height - 24,
  };
  await drag(expandedDragStart, { x: expandedDragStart.x + 60, y: expandedDragStart.y });
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return Math.abs(state.window.x - expanded.window.x) > 40 && state;
  }, 'draggable expanded window');
  await movePointer({ x: 100, y: 100 });

  await activate(awayBundle);
  const collapsed = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.visible && state.window.presentation === 'collapsed'
      && Math.abs(state.window.width - 52) < 0.5 && state;
  }, 'collapsed icon');
  assert.equal(collapsed.window.width, 52);
  assert.equal(collapsed.window.height, 52);

  const center = { x: collapsed.window.x + 26, y: collapsed.window.y + 26 };
  await drag(center, { x: center.x + 70, y: center.y + 20 });
  const dragged = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return Math.abs(state.window.x - collapsed.window.x) > 40 && state;
  }, 'draggable collapsed icon');
  assert.notEqual(dragged.collapsedWindowFrame.x, collapsed.window.x);
  await movePointer({ x: 100, y: 100 });

  await activate(hostBundle);
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).state.window.presentation === 'expanded', 'host re-expansion');
  await activate(awayBundle);
  const collapsedAgain = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.presentation === 'collapsed'
      && Math.abs(state.window.width - 52) < 0.5 && state;
  }, 'second collapse');
  await sendCompanion(socket, { action: 'upsert', plan: {
    id: 'plan-1', title: 'Первый план', revision: 2, status: 'completed', completedAt: new Date().toISOString(),
    steps: [{ id: 'step-1', title: 'Проверить состояние', status: 'completed', progress: 100 }],
  }});
  const completed = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(completed.selected, 'plan-1', 'newly completed plan must become active');
  assert.deepEqual(completed.retentionArmedPlanIDs, [], 'completion while collapsed must not start retention');
  await sendCompanion(socket, { action: 'snapshot', name: 'completed-check-start' });
  await delay(650);
  await sendCompanion(socket, { action: 'snapshot', name: 'completed-check-settled' });
  const [checkStart, checkSettled] = await Promise.all([
    readFile(join(fixture, 'completed-check-start.png')),
    readFile(join(fixture, 'completed-check-settled.png')),
  ]);
  assert.notEqual(createHash('sha256').update(checkStart).digest('hex'),
    createHash('sha256').update(checkSettled).digest('hex'), 'completion check must animate');

  await hover({ x: collapsedAgain.window.x + 26, y: collapsedAgain.window.y + 26 });
  const hoverExpanded = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.presentation === 'expanded' && state;
  }, 'hover expansion');
  assert.ok(hoverExpanded.retentionArmedPlanIDs.includes('plan-1'));
  assert.equal(hoverExpanded.activeStatus, 'completed');

  await sendCompanion(socket, { action: 'remove', id: 'plan-1' });
  await sendCompanion(socket, { action: 'remove', id: 'plan-2' });
  const empty = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.planCount === 0 && !state.visible && state;
  }, 'hidden empty companion');
  assert.equal(empty.planCount, 0);
  console.log(JSON.stringify({ passed: true, fixture }));
} finally {
  await client?.close().catch(() => {});
  try { await activate(awayBundle); } catch {}
  if (app.exitCode === null) {
    try { await sendCompanion(socket, { action: 'quit' }); } catch { app.kill('SIGKILL'); }
  }
}
