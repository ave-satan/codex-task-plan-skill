import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const useFixtureApps = process.env.FOCUS_USE_FIXTURE_APPS === '1';
const keepFixture = process.env.KEEP_FOCUS_FIXTURE === '1';
const hostBundle = process.env.FOCUS_HOST_BUNDLE
  ?? (useFixtureApps ? 'local.taskplan.focus-host' : 'com.apple.finder');
const awayBundle = process.env.FOCUS_AWAY_BUNDLE
  ?? (useFixtureApps ? 'local.taskplan.focus-away' : 'com.openai.codex');
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

async function run(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
}

async function buildFocusApp(name, bundle) {
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
  styleMask: [.titled, .miniaturizable], backing: .buffered, defer: false)
window.title = "${name}"
window.makeKeyAndOrderFront(nil)
let moveURL = URL(fileURLWithPath: "${join(fixture, `${bundle}.move`)}")
let cancelURL = URL(fileURLWithPath: "${join(fixture, `${bundle}.cancel-move`)}")
let minimizeURL = URL(fileURLWithPath: "${join(fixture, `${bundle}.minimize`)}")
let restoreURL = URL(fileURLWithPath: "${join(fixture, `${bundle}.restore`)}")
var moveDeltas: [CGFloat] = []
Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
  if FileManager.default.fileExists(atPath: moveURL.path) {
    try? FileManager.default.removeItem(at: moveURL)
    moveDeltas = Array(repeating: 15, count: 8)
  }
  if FileManager.default.fileExists(atPath: cancelURL.path) {
    try? FileManager.default.removeItem(at: cancelURL)
    moveDeltas = Array(repeating: 15, count: 8) + Array(repeating: -15, count: 8)
  }
  if FileManager.default.fileExists(atPath: minimizeURL.path) {
    try? FileManager.default.removeItem(at: minimizeURL)
    window.miniaturize(nil)
  }
  if FileManager.default.fileExists(atPath: restoreURL.path) {
    try? FileManager.default.removeItem(at: restoreURL)
    window.deminiaturize(nil)
  }
  if !moveDeltas.isEmpty {
    window.setFrameOrigin(NSPoint(x: window.frame.minX + moveDeltas.removeFirst(), y: window.frame.minY))
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

async function activate(bundle, settleMicroseconds = 650000) {
  if (useFixtureApps && [hostBundle, awayBundle].includes(bundle)) {
    await run('/usr/bin/osascript', ['-e', `tell application id "${bundle}" to activate`]);
    await delay(settleMicroseconds / 1000);
    return;
  }
  await runSwift(`
import AppKit
import Darwin
NSRunningApplication.runningApplications(withBundleIdentifier: "${bundle}").first?.activate()
usleep(${settleMicroseconds})
`);
}

async function moveFixtureWindow(bundle, cancelled = false) {
  await writeFile(join(fixture, `${bundle}.${cancelled ? 'cancel-move' : 'move'}`), '1');
  await delay(25);
}

async function setFixtureMiniaturized(bundle, minimized) {
  await writeFile(join(fixture, `${bundle}.${minimized ? 'minimize' : 'restore'}`), '1');
  await delay(25);
}

async function rapidFocusSequence() {
  if (useFixtureApps) {
    for (const bundle of [awayBundle, hostBundle, awayBundle, hostBundle]) {
      await run('/usr/bin/osascript', ['-e', `tell application id "${bundle}" to activate`]);
      await delay(70);
    }
    await delay(650);
    return;
  }
  await runSwift(`
import AppKit
import Darwin
func activate(_ bundle: String) {
  NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first?.activate()
}
activate("${awayBundle}")
usleep(50000)
activate("${hostBundle}")
usleep(50000)
activate("${awayBundle}")
usleep(50000)
activate("${hostBundle}")
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

async function click(point) {
  await runSwift(`
import AppKit
import CoreGraphics
import Darwin
let screenTop = NSScreen.screens.map { $0.frame.maxY }.max()!
let target = CGPoint(x: ${point.x}, y: screenTop - ${point.y})
CGWarpMouseCursorPosition(target)
usleep(120000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: target, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(70000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: target, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(500000)
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

const focusApps = useFixtureApps
  ? [await buildFocusApp('FocusHost', hostBundle), await buildFocusApp('FocusAway', awayBundle)]
  : [];
if (useFixtureApps) await delay(800);

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
  await sendCompanion(socket, { action: 'set_frame', x: 620, y: 260, width: 360, height: 360 });
  for (const [id, title] of [['plan-1', 'Первый план'], ['plan-2', 'Второй план']]) {
    await sendCompanion(socket, { action: 'upsert', plan: {
      id, title, revision: 1, status: 'active',
      steps: [{ id: 'step-1', title: 'Проверить состояние', status: 'in_progress', progress: 35 }],
    }});
  }

  const initiallyCollapsed = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.presentation === 'collapsed' && !state.window.presentationTransitioning && state;
  }, 'initial collapsed fixture');
  assert.equal(initiallyCollapsed.expandedWindowFrame.width, 360);

  const arriving = (await sendCompanion(socket, {
    action: 'workspace_transition_probe', name: 'arriving',
  })).state;
  assert.equal(arriving.window.presentation, 'collapsed');
  assert.equal(arriving.window.presentationTransitioning, false,
    'a Space that merely exposes the host window must keep the compact icon');
  assert.equal(arriving.window.spaceArrivalPending, true);
  assert.equal(arriving.window.lastEarlyPresentationSignal, 'host-window-motion-arriving');

  await activate(hostBundle);
  const expanded = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.visible && state.window.presentation === 'expanded'
      && Math.abs(state.window.width - 360) < 0.5 && state;
  }, 'expanded host window');
  assert.equal(expanded.window.width, 360);
  assert.equal(expanded.window.resizable, true);
  assert.equal(expanded.window.presentationTransitioning, false,
    'arrival on the host Space must restore the plan without a morph');

  await activate(awayBundle, 60000);
  const focusTransition = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(focusTransition.window.presentation, 'collapsing');
  assert.equal(focusTransition.window.presentationTransitioning, true,
    'ordinary focus loss on the host Space must retain the morph');
  assert.equal(focusTransition.window.presentationAnimationDriver,
    'common-runloop-direct-window-frames-60fps');
  assert.equal(focusTransition.window.presentationTweenActive, true);
  const focusWidth = focusTransition.window.width;
  await delay(35);
  const laterFocusTransition = (await sendCompanion(socket, { action: 'status' })).state;
  assert.ok(laterFocusTransition.window.width < focusWidth,
    'focus morph must present another smaller window frame while collapse is running');
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.presentation === 'collapsed' && !state.window.presentationTransitioning && state;
  }, 'focus-loss collapse');

  await activate(hostBundle, 60000);
  const focusExpansion = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(focusExpansion.window.presentationTransitioning, true,
    'ordinary focus return on the host Space must retain the morph');
  const expandedAgain = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.presentation === 'expanded' && !state.window.presentationTransitioning
      && Math.abs(state.window.width - 360) < 0.5 && state;
  }, 'focus-return expansion');

  if (useFixtureApps) {
    await setFixtureMiniaturized(hostBundle, true);
    const minimizing = await eventually(async () => {
      const state = (await sendCompanion(socket, { action: 'status' })).state;
      return state.window.lastEarlyPresentationSignal === 'host-window-minimizing'
        && state.window.presentationTransitioning && state;
    }, 'window minimize starts the morph before focus changes');
    assert.equal(minimizing.window.hostMinimizeDetection,
      'window-server-two-frame-proportional-shrink');
    assert.equal(minimizing.window.lastHostMinimizeTrigger, 'proportional-shrink',
      'the fixture must expose intermediate WindowServer frames, not exercise only the fallback');
    await eventually(async () => {
      const state = (await sendCompanion(socket, { action: 'status' })).state;
      return state.window.hostWindowMinimized && state.window.presentation === 'collapsed'
        && !state.window.presentationTransitioning && state;
    }, 'minimized host leaves the compact icon');

    await setFixtureMiniaturized(hostBundle, false);
    await eventually(async () => {
      const state = (await sendCompanion(socket, { action: 'status' })).state;
      return state.window.lastEarlyPresentationSignal === 'host-window-restoring'
        && state.window.presentationTransitioning && state;
    }, 'window restore starts the focus morph');
    await eventually(async () => {
      const state = (await sendCompanion(socket, { action: 'status' })).state;
      return state.window.presentation === 'expanded' && !state.window.presentationTransitioning
        && Math.abs(state.window.width - 360) < 0.5 && state;
    }, 'restored host expands the plan');
  }

  const expandedDragStart = {
    x: expandedAgain.window.x + 120,
    y: expandedAgain.window.y + expandedAgain.window.height - 24,
  };
  await drag(expandedDragStart, { x: expandedDragStart.x + 60, y: expandedDragStart.y });
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return Math.abs(state.window.x - expandedAgain.window.x) > 40 && state;
  }, 'draggable expanded window');
  await movePointer({ x: 100, y: 100 });

  if (useFixtureApps) {
    await moveFixtureWindow(hostBundle, true);
    const cancelledDeparture = await eventually(async () => {
      const state = (await sendCompanion(socket, { action: 'status' })).state;
      return state.window.lastEarlyPresentationSignal === 'host-window-motion-leaving'
        && state.window.spaceIconProxyVisible && !state.visible
        && state.window.presentation === 'expanded' && state;
    }, 'cancelled Space motion uses a fixed-size proxy without resizing the host window');
    assert.equal(cancelledDeparture.window.spaceIconProxyFrame.width, 52);
    assert.equal(cancelledDeparture.window.spaceIconProxyFrame.height, 52);
    assert.equal(cancelledDeparture.window.spaceOriginWasCollapsed, false);
    const recovered = await eventually(async () => {
      const state = (await sendCompanion(socket, { action: 'status' })).state;
      return state.frontmostBundle === hostBundle && state.window.presentation === 'expanded'
        && !state.window.presentationTransitioning && !state.window.spaceIconProxyVisible && state;
    }, 'cancelled WindowServer motion restores expanded host plan');
    assert.equal(recovered.window.resizable, true);
  }

  if (useFixtureApps) await moveFixtureWindow(hostBundle);
  else await sendCompanion(socket, { action: 'workspace_transition_probe' });
  const earlyTransition = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.spaceIconProxyVisible && !state.visible
      && state.window.presentation === 'expanded' && state;
  }, 'WindowServer host-window motion shows the stable icon proxy');
  assert.equal(earlyTransition.window.presentation, 'expanded',
    'the host-Space presentation state must not change while the Space gesture is running');
  assert.equal(earlyTransition.window.presentationTransitioning, false,
    'Space departure must not run the focus morph');
  assert.equal(earlyTransition.window.lastEarlyPresentationSignal, 'host-window-motion-leaving');
  assert.equal(earlyTransition.window.workspaceTransitionBehavior,
    'fixed-size-proxy-during-space-preserve-host-state');
  assert.equal(earlyTransition.window.workspaceWindowMotionPollingHz, 30);
  assert.equal(earlyTransition.window.spaceIconProxyFrame.width, 52);
  assert.equal(earlyTransition.window.spaceIconProxyFrame.height, 52);
  assert.equal(earlyTransition.window.spaceOriginWasCollapsed, false);

  await sendCompanion(socket, { action: 'workspace_transition_probe', name: 'departure-completed' });
  const departed = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.awayFromHostSpace && state.window.presentation === 'collapsed'
      && !state.window.spaceIconProxyVisible && state;
  }, 'completed Space departure hands off to the normal interactive compact icon');
  assert.equal(departed.window.width, 52);

  await activate(awayBundle, 60000);
  const collapsing = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(collapsing.window.presentation, 'collapsed');
  assert.equal(collapsing.window.presentationTransitioning, false);
  assert.equal(collapsing.window.transitionContent, 'collapsed-icon');
  const collapsed = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.visible && state.window.presentation === 'collapsed'
      && Math.abs(state.window.width - 52) < 0.5 && state;
  }, 'collapsed icon');
  assert.equal(collapsed.window.width, 52);
  assert.equal(collapsed.window.height, 52);
  assert.equal(collapsed.window.presentationTransitioning, false);
  assert.equal(collapsed.window.transitionContent, 'collapsed-icon');
  await sendCompanion(socket, { action: 'snapshot', name: 'collapsed-icon' });

  const center = { x: collapsed.window.x + 26, y: collapsed.window.y + 26 };
  await drag(center, { x: center.x + 70, y: center.y + 20 });
  const dragged = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return Math.abs(state.window.x - collapsed.window.x) > 40 && state;
  }, 'draggable collapsed icon');
  assert.notEqual(dragged.collapsedWindowFrame.x, collapsed.window.x);
  await delay(900);
  const heldAfterDrag = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(heldAfterDrag.window.presentation, 'collapsed',
    'dragging and releasing over the icon must not trigger hover expansion');
  assert.equal(heldAfterDrag.frontmostBundle, awayBundle,
    'finishing a collapsed-icon drag must preserve the current app focus');
  assert.equal(heldAfterDrag.window.collapsedDragSuppressesExpansion, true);
  await movePointer({ x: 100, y: 100 });

  const draggedCenter = {
    x: heldAfterDrag.window.x + heldAfterDrag.window.width / 2,
    y: heldAfterDrag.window.y + heldAfterDrag.window.height / 2,
  };
  await click(draggedCenter);
  try {
    await eventually(async () => {
      const state = (await sendCompanion(socket, { action: 'status' })).state;
      return state.frontmostBundle === hostBundle
        && state.window.presentation === 'expanded' && state.window.resizable && state;
    }, 'collapsed icon click focuses host and re-expands');
  } catch (error) {
    console.error(JSON.stringify({ collapsedClickState: (await sendCompanion(socket, { action: 'status' })).state }));
    throw error;
  }
  const hostExpanded = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(hostExpanded.window.transitionContent, 'full-content',
    'expanded content must appear only after the frame animation completes');
  assert.equal(hostExpanded.window.awayFromHostSpace, false);
  assert.equal(hostExpanded.window.spaceOriginWasCollapsed, null,
    'returning to the Codex Space must consume the saved expanded state');
  await activate('local.taskplan.companion.prototype', 120000);
  const companionFocused = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(companionFocused.window.presentation, 'expanded', 'companion self-focus must not collapse the host window');
  await rapidFocusSequence();
  let rapidStable;
  try {
    rapidStable = await eventually(async () => {
      const state = (await sendCompanion(socket, { action: 'status' })).state;
      return [hostBundle, 'local.taskplan.companion.prototype'].includes(state.frontmostBundle)
        && state.window.presentation === 'expanded'
        && !state.window.presentationTransitioning && Math.abs(state.window.width - 360) < 0.5 && state;
    }, 'stable rapid focus transitions');
  } catch (error) {
    console.error(JSON.stringify({ rapidFocusState: (await sendCompanion(socket, { action: 'status' })).state }));
    throw error;
  }
  assert.equal(rapidStable.expandedWindowFrame.width, 360, 'interrupted animations must not corrupt the saved expanded frame');
  await movePointer({ x: 100, y: 100 });
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
  assert.ok(completed.activeRetentionFraction > 0,
    'completion must start retention immediately even while collapsed');
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
  assert.ok(hoverExpanded.activeRetentionFraction < completed.activeRetentionFraction,
    'focus and hover must not restart the completion deadline');
  assert.equal(hoverExpanded.activeStatus, 'completed');
  assert.equal(hoverExpanded.window.resizable, false, 'hover-expanded unfocused window must not resize');
  const hoverSourceCenter = {
    x: collapsedAgain.window.x + collapsedAgain.window.width / 2,
    y: collapsedAgain.window.y + collapsedAgain.window.height / 2,
  };
  assert.ok(hoverSourceCenter.x >= hoverExpanded.window.x
      && hoverSourceCenter.x <= hoverExpanded.window.x + hoverExpanded.window.width
      && hoverSourceCenter.y >= hoverExpanded.window.y
      && hoverSourceCenter.y <= hoverExpanded.window.y + hoverExpanded.window.height,
    'hover-expanded window must contain the source icon position');
  assert.equal(hoverExpanded.window.hoverExpandedFrameContainsSourceIcon, true);
  assert.equal(hoverExpanded.window.collapsedExpandDelay, 0.7);
  assert.equal(hoverExpanded.window.collapsedBorder, '1pt-white-17pct');
  assert.equal(hoverExpanded.window.stepsSurfaceRGB, '#1F1F21');
  assert.equal((await sendCompanion(socket, { action: 'cursor_probe', x: 1, y: 1 })).kind, 'arrow');

  const activeIcon = {
    x: hoverExpanded.window.x + 24,
    y: hoverExpanded.window.y + hoverExpanded.window.height - 24,
  };
  await hover(activeIcon);
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.planSwitcherExpanded && state;
  }, 'unfocused plan selector expansion');
  await click({ x: activeIcon.x + 28, y: activeIcon.y });
  const switchedUnfocused = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.selected === 'plan-2' && !state.planSwitcherExpanded && state;
  }, 'unfocused plan selection');
  assert.equal(switchedUnfocused.frontmostBundle, awayBundle,
    'selecting another plan must not activate the host application');

  const focusedFrameBefore = hoverExpanded.expandedWindowFrame;
  const unfocusedDragStart = {
    x: hoverExpanded.window.x + 150,
    y: hoverExpanded.window.y + hoverExpanded.window.height - 70,
  };
  await drag(unfocusedDragStart, { x: unfocusedDragStart.x + 45, y: unfocusedDragStart.y - 30 });
  const movedUnfocused = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return Math.abs(state.unfocusedExpandedWindowFrame.x - hoverExpanded.window.x) > 30 && state;
  }, 'independent unfocused expanded position');
  assert.deepEqual(movedUnfocused.expandedWindowFrame, focusedFrameBefore,
    'moving the unfocused expanded window must not overwrite the focused frame');
  assert.equal(movedUnfocused.window.unfocusedExpandedPositionPersistence,
    'state.json:unfocusedExpandedWindowFrame');
  assert.equal(movedUnfocused.frontmostBundle, awayBundle,
    'finishing an unfocused expanded-window drag must preserve the current app focus');

  await click({
    x: movedUnfocused.window.x + 150,
    y: movedUnfocused.window.y + movedUnfocused.window.height - 70,
  });
  const focusedAgain = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.frontmostBundle === hostBundle
      && state.window.presentation === 'expanded' && state.window.resizable
      && Math.abs(state.window.x - focusedFrameBefore.x) < 1 && state;
  }, 'expanded plan click focuses host and restores focused position');
  assert.deepEqual(focusedAgain.unfocusedExpandedWindowFrame, movedUnfocused.unfocusedExpandedWindowFrame,
    'restoring the focused frame must preserve the independent unfocused frame');

  await sendCompanion(socket, { action: 'workspace_transition_probe', name: 'focus-leaving' });
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.presentation === 'collapsed' && !state.window.presentationTransitioning && state;
  }, 'diagnostic collapse before collapsed-origin Space test');
  const collapsedOrigin = (await sendCompanion(socket, {
    action: 'workspace_transition_probe',
  })).state;
  assert.equal(collapsedOrigin.window.spaceOriginWasCollapsed, true);
  assert.equal(collapsedOrigin.window.spaceIconProxyVisible, false,
    'an already compact host window must not need a transition proxy');
  await sendCompanion(socket, { action: 'workspace_transition_probe', name: 'departure-completed' });
  await sendCompanion(socket, { action: 'workspace_transition_probe', name: 'return-completed' });
  const collapsedRestored = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return !state.window.awayFromHostSpace && state.window.presentation === 'collapsed'
      && !state.window.presentationTransitioning && state;
  }, 'collapsed host-Space state survives a complete Space roundtrip');
  assert.equal(collapsedRestored.window.width, 52);
  assert.equal(collapsedRestored.window.spaceOriginWasCollapsed, null);

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
  if (useFixtureApps) {
    for (const bundle of [hostBundle, awayBundle]) {
      try { await run('/usr/bin/osascript', ['-e', `tell application id "${bundle}" to quit`]); } catch {}
    }
    await Promise.all(focusApps.map(child => child.exitCode === null
      ? Promise.race([once(child, 'exit'), delay(3000).then(() => child.kill('SIGKILL'))])
      : undefined));
    if (keepFixture) console.error(JSON.stringify({ fixture }));
    else await rm(fixture, { recursive: true, force: true });
  }
}
