import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

// Isolated diagnostic. Never reads or modifies the task-plan database.
export async function registerNativeEventProbe(server) {
  const { registerSseProbe } = await import('./sse-probe.mjs');
  await registerSseProbe(server).catch(error => console.error('SSE probe unavailable:', error.message));
  const directory = await mkdtemp(join(tmpdir(), 'task-plan-native-event-'));
  const statePath = join(directory, 'state.json');
  const reportPath = join(directory, 'report.json');
  const stateUri = pathToFileURL(statePath).href;
  // Tool metadata can outlive a server process. Never publish its random temp path.
  // Keep file: so the host can resolve this resource in its native file bridge.
  const widgetUri = new URL('./native-event-probe.html', import.meta.url).href;
  let state = { run: randomUUID(), value: 0 };
  let report = { stage: 'not_started', stateUri, reportPath };
  let timer;
  await writeFile(statePath, JSON.stringify(state));
  const html = (await readFile(new URL('./native-event-probe.html', import.meta.url), 'utf8'))
    .replace('__STATE_URI__', JSON.stringify(stateUri));
  await writeFile(join(directory, 'widget.html'), html);
  const save = async () => writeFile(reportPath, JSON.stringify(report, null, 2));
  await save();
  registerAppResource(server, 'Native event probe UI', widgetUri, {}, async () => ({
    contents: [{ uri: widgetUri, mimeType: RESOURCE_MIME_TYPE, text: html }],
  }));
  server.registerResource('Native event probe counter', stateUri, { mimeType: 'application/json' }, async () => ({
    contents: [{ uri: stateUri, mimeType: 'application/json', text: await readFile(statePath, 'utf8') }],
  }));
  registerAppTool(server, 'show_native_event_probe', {
    description: 'Open the isolated native file-event delivery test. No polling; does not modify task plans. Only one probe run is supported per server process.',
    inputSchema: {},
    _meta: { ui: { resourceUri: widgetUri }, 'openai/outputTemplate': widgetUri },
  }, async () => ({
    content: [{ type: 'text', text: 'Native event probe opened; success requires an iframe receipt.' }],
    structuredContent: { stateUri, reportPath, run: state.run },
  }));
  registerAppTool(server, 'native_event_probe_control', {
    description: 'Diagnostic control: arm once after subscribing, report iframe receipt, or inspect the result. No plan changes.',
    inputSchema: {
      action: z.enum(['arm', 'receipt', 'error', 'status']),
      value: z.number().optional(), run: z.string().optional(),
      message: z.string().max(1000).optional(), events: z.number().int().optional(),
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({ action, value, run, message, events }) => {
    if (action === 'arm' && report.stage === 'not_started') {
      report = { ...report, stage: 'subscribed', subscribedAt: new Date().toISOString() };
      await save();
      timer = setTimeout(async () => {
        try {
          state = { ...state, value: 1 };
          await writeFile(statePath, JSON.stringify(state));
          report = { ...report, fileChangedAt: new Date().toISOString() };
          await save();
        } catch (e) { report = { ...report, stage: 'error', message: String(e) }; await save(); }
      }, 1200);
      timer.unref();
    } else if (action === 'receipt') {
      const valid = run === state.run && value === 1 && state.value === 1 && events > 0;
      report = { ...report, stage: valid ? 'delivered' : 'invalid_receipt', value, run, events, receivedAt: new Date().toISOString() };
      await save();
    } else if (action === 'error') {
      report = { ...report, stage: 'error', message };
      await save();
    }
    return { content: [{ type: 'text', text: JSON.stringify(report) }], structuredContent: report };
  });
}
