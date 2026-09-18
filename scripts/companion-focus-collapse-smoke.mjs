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
let initialFrame = window.frame
var moveDeltas: [CGFloat] = []
Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
  if FileManager.default.fileExists(atPath: moveURL.path) {
    try? FileManager.default.removeItem(at: moveURL)
    moveDeltas = Array(repeating: 15, count: 8)
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
    window.setFrame(initialFrame, display: true)
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
    env: { ...process.env, TASK_PLAN_DB: ':memory:', TASK_PLAN_COMPANION_SOCKET: socket },
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
  assert.equal(attached.window.panelLevel, 3);

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
    return state.window.liveResizeCursorKind === 'left' && state;
  }, 'nonactivating resize cursor');
  assert.equal(cursor.frontmostBundle, awayBundle,
    'hovering a resize edge must not activate the companion or flash Codex traffic lights');
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

  await sendCompanion(socket, { action: 'workspace_transition_probe', name: 'departure-completed' });
  const remote = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.awayFromHostSpace && state.window.presentation === 'collapsed' && state;
  }, 'remote Space keeps only the interactive compact icon');
  assert.equal(remote.window.panelLevel, 3);
  assert.equal(remote.window.spaceMirrorPresentation, 'expanded');

  await signal(hostBundle, 'reset');
  await sendCompanion(socket, { action: 'workspace_transition_probe', name: 'return-completed' });
  const returned = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return !state.window.awayFromHostSpace && state.window.presentation === 'expanded'
      && state.window.panelLevel === 3 && !state.window.spaceMirrorVisible && state;
  }, 'return to Codex Space restores the attached expanded panel');
  assert.equal(returned.window.focusCollapseEnabled, false);

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
