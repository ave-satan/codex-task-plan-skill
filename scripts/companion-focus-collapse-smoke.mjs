import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sendCompanion } from '../companion-bridge.mjs';

const binary = process.env.COMPANION_BINARY;
assert.ok(binary, 'Set COMPANION_BINARY to the built native companion');
const keepFixture = process.env.KEEP_FOCUS_FIXTURE === '1';
const hostBundle = 'local.taskplan.focus-host';
const awayBundle = 'local.taskplan.focus-away';
const fixture = await mkdtemp('/tmp/taskplan-host-attachment-');
const socket = join(fixture, 'control.sock');
const missionControlMarker = join(fixture, 'mission-control.active');
const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(read, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; } catch {}
    await delay(50);
  }
  throw new Error(`Timed out: ${message}`);
}

function assertFrameEqual(actual, expected, message) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1,
      `${message}: ${key} ${actual[key]} != ${expected[key]}`);
  }
}

async function run(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
}

async function runSwift(source) {
  await run('/usr/bin/swift', ['-e', source]);
}

async function buildFixtureApp(name, bundle) {
  const appRoot = join(fixture, `${name}.app`);
  const macOS = join(appRoot, 'Contents', 'MacOS');
  const executable = join(macOS, name);
  await mkdir(macOS, { recursive: true });
  await writeFile(join(appRoot, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundleIdentifier</key><string>${bundle}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
  const source = join(fixture, `${name}.swift`);
  await writeFile(source, `import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 640, height: 480),
  styleMask: [.titled, .miniaturizable, .resizable], backing: .buffered, defer: false)
window.title = "${name}"
window.makeKeyAndOrderFront(nil)
let moveURL = URL(fileURLWithPath: "${join(fixture, `${bundle}.space-move`)}")
let verticalURL = URL(fileURLWithPath: "${join(fixture, `${bundle}.vertical-move`)}")
let resizeURL = URL(fileURLWithPath: "${join(fixture, `${bundle}.resize`)}")
let minimizeURL = URL(fileURLWithPath: "${join(fixture, `${bundle}.minimize`)}")
let restoreURL = URL(fileURLWithPath: "${join(fixture, `${bundle}.restore`)}")
let resetURL = URL(fileURLWithPath: "${join(fixture, `${bundle}.reset`)}")
let overviewURL = URL(fileURLWithPath: "${join(fixture, `${bundle}.overview-move`)}")
var spaceBaseline = window.frame
var moveDeltas: [CGFloat] = []
var overviewFrames: [NSRect] = []
Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
  if FileManager.default.fileExists(atPath: moveURL.path) {
    try? FileManager.default.removeItem(at: moveURL)
    spaceBaseline = window.frame
    moveDeltas = Array(repeating: 15, count: 8)
  }
  if FileManager.default.fileExists(atPath: overviewURL.path) {
    try? FileManager.default.removeItem(at: overviewURL)
    spaceBaseline = window.frame
    overviewFrames = []
    for step in 1...8 {
      let offset = CGFloat(step)
      let origin = NSPoint(x: spaceBaseline.minX + offset * 15,
                           y: spaceBaseline.minY + offset * 2)
      let size = NSSize(width: spaceBaseline.width - offset * 13,
                        height: spaceBaseline.height - offset * 10)
      overviewFrames.append(NSRect(origin: origin, size: size))
    }
  }
  if FileManager.default.fileExists(atPath: verticalURL.path) {
    try? FileManager.default.removeItem(at: verticalURL)
    window.setFrameOrigin(NSPoint(x: window.frame.minX, y: window.frame.minY + 70))
  }
  if let data = try? Data(contentsOf: resizeURL),
     let value = String(data: data, encoding: .utf8) {
    try? FileManager.default.removeItem(at: resizeURL)
    let parts = value.split(separator: ",").compactMap { Double($0) }
    if parts.count == 2 {
      window.setFrame(NSRect(origin: window.frame.origin,
                             size: NSSize(width: parts[0], height: parts[1])), display: true)
    }
  }
  if FileManager.default.fileExists(atPath: minimizeURL.path) {
    try? FileManager.default.removeItem(at: minimizeURL)
    window.miniaturize(nil)
  }
  if FileManager.default.fileExists(atPath: restoreURL.path) {
    try? FileManager.default.removeItem(at: restoreURL)
    window.deminiaturize(nil)
  }
  if FileManager.default.fileExists(atPath: resetURL.path) {
    try? FileManager.default.removeItem(at: resetURL)
    moveDeltas = []
    overviewFrames = []
    window.setFrame(spaceBaseline, display: true)
  }
  if !overviewFrames.isEmpty {
    window.setFrame(overviewFrames.removeFirst(), display: true)
  }
  if !moveDeltas.isEmpty {
    window.setFrameOrigin(NSPoint(x: window.frame.minX + moveDeltas.removeFirst(),
                                  y: window.frame.minY))
  }
}
app.run()
`);
  await run('/usr/bin/swiftc', [
    '-swift-version', '5', '-module-cache-path', join(fixture, 'module-cache'),
    source, '-o', executable, '-framework', 'AppKit',
  ]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', appRoot]);
  return spawn('/usr/bin/open', ['-W', '-n', appRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function activate(bundle, settle = 650) {
  await run('/usr/bin/osascript', ['-e', `tell application id "${bundle}" to activate`]);
  await delay(settle);
}

async function signal(bundle, name, value = '1') {
  await writeFile(join(fixture, `${bundle}.${name}`), value);
  await delay(40);
}

async function movePointer(point) {
  await runSwift(`
import AppKit
import CoreGraphics
import Darwin
let screenTop = NSScreen.screens.map { $0.frame.maxY }.max()!
CGWarpMouseCursorPosition(CGPoint(x: ${point.x}, y: screenTop - ${point.y}))
usleep(250000)
`);
}

async function drag(from, to) {
  await runSwift(`
import AppKit
import CoreGraphics
import Darwin
let screenTop = NSScreen.screens.map { $0.frame.maxY }.max()!
func q(_ p: (Double, Double)) -> CGPoint { CGPoint(x: p.0, y: screenTop - p.1) }
let start = q((${from.x}, ${from.y}))
let finish = q((${to.x}, ${to.y}))
CGWarpMouseCursorPosition(start)
usleep(100000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(60000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: finish, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(100000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: finish, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(450000)
`);
}

const fixtureApps = [
  await buildFixtureApp('FocusHost', hostBundle),
  await buildFixtureApp('FocusAway', awayBundle),
];
await delay(800);

const app = spawn(binary, [], { env: {
  ...process.env,
  PLAN_COMPANION_DATA: fixture,
  PLAN_COMPANION_SOCKET: socket,
  PLAN_COMPANION_HOST: hostBundle,
  PLAN_COMPANION_TEST_MISSION_CONTROL_MARKER: missionControlMarker,
  PLAN_COMPANION_RETENTION_SECONDS: '10',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let client;

try {
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).ok,
    'companion startup');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'server.mjs')],
    cwd: root,
    env: { ...process.env, TASK_PLAN_DB: ':memory:', TASK_PLAN_COMPANION_SOCKET: socket,
      TASK_PLAN_COMPANION_AUTOSTART: '0' },
  });
  client = new Client({ name: 'host-attachment-smoke', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  const compatibility = await client.callTool({
    name: 'set_companion_focus_mode', arguments: { enabled: true },
  });
  assert.equal(compatibility.structuredContent?.enabled, false,
    'focus-collapse must remain retired even when a legacy caller requests it');

  await sendCompanion(socket, { action: 'upsert', plan: {
    id: 'plan-1', title: 'Привязка к Codексу', revision: 1, status: 'active',
    steps: [{ id: 'step-1', title: 'Проверить окно', status: 'in_progress', progress: 35 }],
  }});
  await activate(hostBundle);
  await sendCompanion(socket, { action: 'set_frame', x: 220, y: 180, width: 320, height: 280 });
  const attached = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.hostAttachment && state.window.presentation === 'expanded' && state;
  }, 'initial host attachment');
  assert.equal(attached.window.focusCollapseEnabled, false);
  assert.equal(attached.window.focusPresentationBehavior,
    'expanded-on-host-space-no-focus-collapse');
  assert.equal(attached.window.panelLevel, 3,
    `host activation must float the panel; frontmost=${attached.frontmostBundle}`);

  await activate(awayBundle);
  const unfocused = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.frontmostBundle === awayBundle && state.window.presentation === 'expanded'
      && !state.window.presentationTransitioning && state;
  }, 'focus loss keeps the host-space panel expanded');
  assert.equal(unfocused.window.width, attached.window.width);
  assert.equal(unfocused.window.panelLevel, 0,
    'the expanded panel must use normal level so foreground apps cover it');

  await movePointer({ x: unfocused.window.x + 1, y: unfocused.window.y + unfocused.window.height / 2 });
  const cursor = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === null && state;
  }, 'covered plan must not override the foreground app cursor');
  assert.equal(cursor.frontmostBundle, awayBundle,
    'hovering a covered resize edge must not activate the companion or flash Codex traffic lights');
  assert.equal(cursor.window.resizeCursorActivatesApplication, false);
  assert.equal(cursor.window.resizeCursorTracking, 'explicit-7pt-edge-12pt-corner-nonactivating');

  await activate(hostBundle);
  const beforeResize = (await sendCompanion(socket, { action: 'status' })).state;
  const attachmentBeforeResize = beforeResize.window.hostAttachment;
  await signal(hostBundle, 'resize', '800,640');
  const resizedWithHost = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.hostWindowObservation?.width > beforeResize.window.hostWindowObservation.width + 100
      && state.window.width > beforeResize.window.width + 30 && state;
  }, 'plan resizes proportionally with Codex');
  assert.ok(Math.abs(resizedWithHost.window.hostAttachment.width - attachmentBeforeResize.width) < 0.001);
  assert.ok(Math.abs(resizedWithHost.window.hostAttachment.height - attachmentBeforeResize.height) < 0.001);

  const beforeMoveY = resizedWithHost.window.y;
  await signal(hostBundle, 'vertical-move');
  const movedWithHost = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return Math.abs(state.window.y - beforeMoveY) > 40 && state;
  }, 'plan moves with Codex');

  await sendCompanion(socket, {
    action: 'set_frame',
    x: movedWithHost.window.x + 45,
    y: movedWithHost.window.y - 20,
    width: movedWithHost.window.width,
    height: movedWithHost.window.height,
  });
  const independentlyMoved = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return Math.abs(state.window.hostAttachment.x - movedWithHost.window.hostAttachment.x) > 0.01 && state;
  }, 'independent plan drag updates its attachment');
  assert.equal(independentlyMoved.window.presentation, 'expanded');

  await sendCompanion(socket, {
    action: 'set_frame',
    x: independentlyMoved.window.x,
    y: independentlyMoved.window.y,
    width: independentlyMoved.window.width + 42,
    height: independentlyMoved.window.height,
  });
  const independentlyResized = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.width > independentlyMoved.window.width + 20 && state;
  }, 'independent plan resize updates its attachment');
  assert.ok(independentlyResized.window.hostAttachment.width
    > independentlyMoved.window.hostAttachment.width);

  const beforeOverview = (await sendCompanion(socket, { action: 'status' })).state;
  const overviewFrame = {
    x: beforeOverview.window.x,
    y: beforeOverview.window.y,
    width: beforeOverview.window.width,
    height: beforeOverview.window.height,
  };
  await signal(hostBundle, 'overview-move');
  const overview = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.hostMinimizingActive && !state.visible && state;
  }, 'Mission Control-like host scaling hides the plan');
  assert.equal(overview.window.spaceDepartureActive, false,
    'scaling plus translation must not be mistaken for a Space swipe');
  assert.equal(overview.window.spaceMirrorVisible, false);
  assertFrameEqual({
    x: overview.window.x,
    y: overview.window.y,
    width: overview.window.width,
    height: overview.window.height,
  }, overviewFrame, 'overview transform must not change the attached plan frame');
  await delay(700);
  const overviewStable = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(overviewStable.visible, false,
    'the plan must stay hidden while the scaled overview thumbnail remains');
  assert.equal(overviewStable.window.spaceDepartureActive, false);
  assert.equal(overviewStable.window.spaceMirrorVisible, false);
  await signal(hostBundle, 'reset');
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return !state.window.hostMinimizingActive && state.visible
      && !state.window.spaceDepartureActive && state;
  }, 'plan returns after the host leaves overview');

  await writeFile(missionControlMarker, '1');
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.missionControlSuspended && !state.visible
      && !state.window.spaceMirrorVisible && !state.window.spaceRemoteIconVisible && state;
  }, 'Mission Control hides all plan windows');
  await signal(hostBundle, 'space-move');
  await sendCompanion(socket, { action: 'workspace_transition_probe', name: 'departure-completed' });
  await delay(700);
  const insideMissionControl = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(insideMissionControl.window.missionControlSuspended, true);
  assert.equal(insideMissionControl.visible, false,
    'Space motion inside Mission Control must not reveal the plan');
  assert.equal(insideMissionControl.window.spaceDepartureActive, false);
  assert.equal(insideMissionControl.window.spaceMirrorVisible, false);
  assert.equal(insideMissionControl.window.spaceRemoteIconVisible, false);
  await rm(missionControlMarker);
  await signal(hostBundle, 'reset');
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return !state.window.missionControlSuspended && state.visible
      && state.window.presentation === 'expanded' && state;
  }, 'plan reappears only after Mission Control exits');
  assert.equal((await sendCompanion(socket, { action: 'status' })).state.window.spaceRemoteIconVisible,
    false, 'Codex Space must not keep a separate remote icon after Mission Control');

  await signal(hostBundle, 'minimize');
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.hostWindowMinimized && !state.visible
      && state.window.presentation === 'expanded' && state;
  }, 'minimized Codex hides the expanded plan without creating an icon');
  await signal(hostBundle, 'restore');
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return !state.window.hostWindowMinimized && state.visible
      && state.window.presentation === 'expanded' && state;
  }, 'restored Codex restores the attached expanded plan');

  await activate(hostBundle);
  const beforeSpace = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.presentation === 'expanded'
      && !state.window.presentationTransitioning && state;
  }, 'stable plan frame before Space swipe');
  const frozenFrame = {
    x: beforeSpace.window.x,
    y: beforeSpace.window.y,
    width: beforeSpace.window.width,
    height: beforeSpace.window.height,
  };
  assert.equal(beforeSpace.window.spaceRemoteIconVisible, false,
    'the separate remote icon stays hidden while the expanded plan is on Codex Space');
  await signal(hostBundle, 'space-move');
  const departing = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.spaceDepartureActive && state.window.spaceMirrorVisible
      && state.window.spaceMirrorPresentation === 'expanded'
      && state.window.presentation === 'collapsed' && state;
  }, 'Space swipe uses expanded host mirror and remote compact icon');
  assert.equal(departing.window.spaceOriginWasCollapsed, false);
  assert.equal(departing.window.spaceRemoteIconVisible, true);
  assert.equal(departing.window.width, 52);
  assertFrameEqual(departing.window.spaceMirrorFrame, frozenFrame,
    'host mirror must stay at the pre-swipe frame');
  assertFrameEqual(departing.window.spaceHostExpandedFrame, frozenFrame,
    'frozen host frame must not follow the sliding Codex window');

  await sendCompanion(socket, { action: 'workspace_transition_probe', name: 'departure-completed' });
  const remote = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.awayFromHostSpace && state.window.presentation === 'collapsed' && state;
  }, 'remote Space keeps only the interactive compact icon');
  assert.equal(remote.window.panelLevel, 3);
  assert.equal(remote.window.spaceMirrorPresentation, 'expanded');

  const arriving = await sendCompanion(socket,
    { action: 'workspace_transition_probe', name: 'arriving' });
  assert.equal(arriving.state.window.spaceArrivalPending, true);
  assert.equal(arriving.state.window.alpha, 0,
    'compact icon must disappear as soon as the host Space starts returning');
  const cancelledArrival = await sendCompanion(socket,
    { action: 'workspace_transition_probe', name: 'arrival-cancelled' });
  assert.equal(cancelledArrival.state.window.spaceArrivalPending, false);
  assert.ok(Math.abs(cancelledArrival.state.window.alpha - 0.82) < 0.01,
    'a cancelled return must show the compact icon again');
  const returning = await sendCompanion(socket,
    { action: 'workspace_transition_probe', name: 'arriving' });
  assert.equal(returning.state.window.alpha, 0);

  await signal(hostBundle, 'reset');
  const restoreResponse = await sendCompanion(socket,
    { action: 'workspace_transition_probe', name: 'return-completed' });
  assert.equal(restoreResponse.state.window.hostSpaceRestorePending, true);
  assert.equal(restoreResponse.state.window.spaceRemoteIconVisible, false,
    'returning to Codex hides the remote icon before showing the expanded plan');
  assertFrameEqual({
    x: restoreResponse.state.window.x,
    y: restoreResponse.state.window.y,
    width: restoreResponse.state.window.width,
    height: restoreResponse.state.window.height,
  }, frozenFrame, 'restored plan must appear at the frozen frame immediately');
  const returned = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return !state.window.awayFromHostSpace && state.window.presentation === 'expanded'
      && state.window.panelLevel === 3 && !state.window.spaceMirrorVisible
      && !state.window.hostSpaceRestorePending && state;
  }, 'return to Codex Space restores the attached expanded panel');
  assert.equal(returned.window.focusCollapseEnabled, false);
  assert.equal(returned.window.spaceRemoteIconVisible, false,
    'remote icon must remain hidden after the host frame stabilizes');
  assertFrameEqual({
    x: returned.window.x,
    y: returned.window.y,
    width: returned.window.width,
    height: returned.window.height,
  }, frozenFrame, 'stable post-swipe frame must match the pre-swipe frame');

  await sendCompanion(socket, { action: 'remove', id: 'plan-1' });
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.planCount === 0 && !state.visible && state;
  }, 'empty companion hides all representations');
  console.log(JSON.stringify({ passed: true, fixture }));
} finally {
  await client?.close().catch(() => {});
  try { await activate(awayBundle); } catch {}
  if (app.exitCode === null) {
    try { await sendCompanion(socket, { action: 'quit' }); } catch { app.kill('SIGKILL'); }
  }
  for (const bundle of [hostBundle, awayBundle]) {
    try { await run('/usr/bin/osascript', ['-e', `tell application id "${bundle}" to quit`]); } catch {}
  }
  await Promise.all(fixtureApps.map(child => child.exitCode === null
    ? Promise.race([once(child, 'exit'), delay(3000).then(() => child.kill('SIGKILL'))])
    : undefined));
  if (keepFixture) console.error(JSON.stringify({ fixture }));
  else await rm(fixture, { recursive: true, force: true });
}
