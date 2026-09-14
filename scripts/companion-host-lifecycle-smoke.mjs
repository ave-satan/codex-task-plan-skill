import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { sendCompanion } from '../companion-bridge.mjs';

const binary = process.env.COMPANION_BINARY;
assert.ok(binary, 'Set COMPANION_BINARY to the built native companion');
const fixture = await mkdtemp('/tmp/taskplan-host-lifecycle-');
const appBundle = join(fixture, 'LifecycleHost.app');
const appMacOS = join(appBundle, 'Contents', 'MacOS');
const hostBinary = join(appMacOS, 'LifecycleHost');
const hostBundle = 'local.taskplan.lifecycle-host';
const socket = join(fixture, 'control.sock');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
}

async function eventually(read, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; } catch {}
    await delay(50);
  }
  throw new Error(`Timed out: ${message}`);
}

await mkdir(appMacOS, { recursive: true });
await writeFile(join(appBundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>LifecycleHost</string>
<key>CFBundleIdentifier</key><string>${hostBundle}</string>
<key>CFBundleName</key><string>LifecycleHost</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
const source = join(fixture, 'host.swift');
await writeFile(source, `import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.run()
`);
await run('/usr/bin/swiftc', [
  '-swift-version', '5', '-module-cache-path', join(fixture, 'module-cache'),
  source, '-o', hostBinary, '-framework', 'AppKit',
]);
await run('/usr/bin/codesign', ['--force', '--sign', '-', appBundle]);

const host = spawn('/usr/bin/open', ['-W', '-n', appBundle], { stdio: ['ignore', 'pipe', 'pipe'] });
let companion;
try {
  await eventually(async () => {
    const check = spawn('/usr/bin/osascript', ['-e', `application id "${hostBundle}" is running`],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    check.stdout.on('data', chunk => { output += chunk; });
    await once(check, 'exit');
    return output.trim() === 'true';
  }, 'fixture host startup');

  companion = spawn(binary, [], { env: {
    ...process.env,
    PLAN_COMPANION_DATA: join(fixture, 'companion'),
    PLAN_COMPANION_SOCKET: socket,
    PLAN_COMPANION_HOST: hostBundle,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  await eventually(async () => (await sendCompanion(socket, { action: 'status' })).ok,
    'companion startup');

  await run('/usr/bin/osascript', ['-e', `tell application id "${hostBundle}" to quit`]);
  if (host.exitCode === null) await once(host, 'exit');
  const exit = await Promise.race([
    once(companion, 'exit').then(([code, signal]) => ({ code, signal })),
    delay(8000).then(() => null),
  ]);
  assert.ok(exit, 'companion must exit after its host application terminates');
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0);
  console.log(JSON.stringify({ passed: true, fixture }));
} finally {
  if (host.exitCode === null) host.kill('SIGKILL');
  if (companion?.exitCode === null) companion.kill('SIGKILL');
  await rm(fixture, { recursive: true, force: true });
}
