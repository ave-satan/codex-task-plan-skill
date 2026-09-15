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

async function eventually(predicate) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await delay(40);
  }
  throw new Error('Timed out waiting for live cursor state');
}

const app = spawn(binary, [], { env: { ...process.env,
  PLAN_COMPANION_DATA: fixture, PLAN_COMPANION_SOCKET: socket, PLAN_COMPANION_HOST: hostBundle },
  stdio: ['ignore', 'pipe', 'pipe'] });

try {
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).ok);
  await sendCompanion(socket, { action: 'upsert', plan: {
    id: 'cursor-live', title: 'Cursor live', revision: 1, status: 'active',
    steps: [{ id: 'one', title: 'Hover edge', status: 'pending' }]
  }});
  await sendCompanion(socket, { action: 'set_frame', x: 500, y: 300, width: 420, height: 430 });
  const activator = spawn('/usr/bin/swift', ['-e', `
import AppKit
import Darwin
NSRunningApplication.runningApplications(withBundleIdentifier: "${hostBundle}").first?.activate()
usleep(500000)
`], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(activator, 'exit');
  const initial = (await sendCompanion(socket, { action: 'status' })).state;
  assert.equal(initial.visible, true, `Bring ${hostBundle} to the foreground before running this test`);

  const swift = `
import AppKit
import CoreGraphics
import Darwin
let old = CGEvent(source: nil)!.location
let top = NSScreen.screens.first!.frame.maxY
CGWarpMouseCursorPosition(CGPoint(x: 502, y: top - 515))
print("WARPED"); fflush(stdout)
usleep(650000)
let current = NSCursor.currentSystem
let candidates = [NSCursor.frameResize(position: .left, directions: .all), NSCursor.resizeLeftRight]
let match = candidates.contains { current?.hotSpot == $0.hotSpot && current?.image.size == $0.image.size }
let edgeCustom = current?.hotSpot == NSCursor.resizeLeftRight.hotSpot && current?.image.tiffRepresentation == NSCursor.resizeLeftRight.image.tiffRepresentation
print("SYSTEM_RESIZE=\\(match)"); fflush(stdout)
print("EDGE_CUSTOM=\\(edgeCustom)"); fflush(stdout)
CGWarpMouseCursorPosition(CGPoint(x: 516, y: top - 515))
print("INSIDE_TRANSITION"); fflush(stdout)
usleep(650000)
let inside = NSCursor.currentSystem
let insideResize = candidates.contains { inside?.hotSpot == $0.hotSpot && inside?.image.size == $0.image.size }
let insideCustom = inside?.hotSpot == NSCursor.resizeLeftRight.hotSpot && inside?.image.tiffRepresentation == NSCursor.resizeLeftRight.image.tiffRepresentation
print("INSIDE_TRANSITION_RESIZE=\\(insideResize)"); fflush(stdout)
print("INSIDE_TRANSITION_CUSTOM=\\(insideCustom)"); fflush(stdout)
let dragStart = CGPoint(x: 516, y: top - 515)
let dragEnd = CGPoint(x: 536, y: top - 515)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: dragStart, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(80000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: dragEnd, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(120000)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: dragEnd, mouseButton: .left)!.post(tap: .cghidEventTap)
print("DRAGGED"); fflush(stdout)
usleep(300000)
CGWarpMouseCursorPosition(CGPoint(x: 544, y: top - 515))
print("DEEP_INSIDE"); fflush(stdout)
usleep(500000)
CGWarpMouseCursorPosition(CGPoint(x: 516, y: top - 515))
print("OUTSIDE"); fflush(stdout)
usleep(650000)
let outside = NSCursor.currentSystem
let outsideResize = candidates.contains { outside?.hotSpot == $0.hotSpot && outside?.image.size == $0.image.size }
print("OUTSIDE_RESIZE=\\(outsideResize)"); fflush(stdout)
usleep(150000)
CGWarpMouseCursorPosition(CGPoint(x: 508, y: top - 515))
print("FAR_OUTSIDE"); fflush(stdout)
usleep(450000)
CGWarpMouseCursorPosition(old)
exit(match && edgeCustom && insideResize && insideCustom && !outsideResize ? 0 : 2)
`;
  const mover = spawn('/usr/bin/swift', ['-e', swift], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let announceWarp;
  const warped = new Promise(resolve => { announceWarp = resolve; });
  let announceOutside;
  const outside = new Promise(resolve => { announceOutside = resolve; });
  let announceInside;
  const inside = new Promise(resolve => { announceInside = resolve; });
  let announceDeepInside;
  const deepInside = new Promise(resolve => { announceDeepInside = resolve; });
  let announceDragged;
  const dragged = new Promise(resolve => { announceDragged = resolve; });
  let announceFarOutside;
  const farOutside = new Promise(resolve => { announceFarOutside = resolve; });
  mover.stdout.on('data', data => {
    output += data;
    if (output.includes('WARPED')) announceWarp();
    if (output.includes('INSIDE_TRANSITION')) announceInside();
    if (output.includes('DRAGGED')) announceDragged();
    if (output.includes('DEEP_INSIDE')) announceDeepInside();
    if (output.includes('OUTSIDE')) announceOutside();
    if (output.includes('FAR_OUTSIDE')) announceFarOutside();
  });
  await warped;
  const during = await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === 'left' && state;
  });
  await inside;
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === 'left' && state.window.fallbackResizeCursorSuppressed === false;
  });
  await dragged;
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return Math.abs(state.window.x - 520) < 1 && Math.abs(state.window.width - 400) < 1;
  });
  await deepInside;
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === null && state.window.fallbackResizeCursorSuppressed === false;
  });
  await outside;
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.window.liveResizeCursorKind === null && state;
  });
  await farOutside;
  const [exitCode] = await once(mover, 'exit');
  assert.equal(exitCode, 0, output.trim());
  assert.match(output, /SYSTEM_RESIZE=true/);
  assert.match(output, /EDGE_CUSTOM=true/);
  assert.match(output, /INSIDE_TRANSITION_RESIZE=true/);
  assert.match(output, /INSIDE_TRANSITION_CUSTOM=true/);
  assert.match(output, /OUTSIDE_RESIZE=false/);

  const vertical = spawn('/usr/bin/swift', ['-e', `
import AppKit
import CoreGraphics
import Darwin
let old = CGEvent(source: nil)!.location
let top = NSScreen.screens.first!.frame.maxY
func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: top - y) }
func drag(_ start: CGPoint, _ end: CGPoint) {
  CGWarpMouseCursorPosition(start)
  usleep(250000)
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)!.post(tap: .cghidEventTap)
  usleep(80000)
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: end, mouseButton: .left)!.post(tap: .cghidEventTap)
  usleep(120000)
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left)!.post(tap: .cghidEventTap)
  usleep(250000)
}
drag(point(720, 728), point(720, 748))
drag(point(720, 302), point(720, 282))
CGWarpMouseCursorPosition(point(100, 100))
usleep(650000)
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal((await once(vertical, 'exit'))[0], 0);
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return Math.abs(state.window.x - 520) < 1 && Math.abs(state.window.width - 400) < 1
      && Math.abs(state.window.y - 280) < 1 && Math.abs(state.window.height - 470) < 1;
  });
  await eventually(async () => {
    const state = (await sendCompanion(socket, { action: 'status' })).state;
    return state.frontmostBundle === hostBundle && state.window.liveResizeCursorKind === null;
  });
  console.log('Live cursor smoke passed: horizontal, top and bottom edge drags resize the frame; the outer transition clears.');
} finally {
  if (app.exitCode === null) {
    try { await sendCompanion(socket, { action: 'quit' }); } catch { app.kill('SIGKILL'); }
  }
}
