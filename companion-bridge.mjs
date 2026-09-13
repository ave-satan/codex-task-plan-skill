import net from 'node:net';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function launchCompanionForCreation(socket) {
  if (process.env.TASK_PLAN_COMPANION_AUTOSTART !== '1') return;
  try { await sendCompanion(socket, { action: 'status' }); return; }
  catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) return;
  }
  const binary = process.env.TASK_PLAN_COMPANION_BINARY ?? fileURLToPath(new URL('./companion/build/Task Plan Companion.app/Contents/MacOS/TaskPlanCompanion', import.meta.url));
  const child = spawn(binary, [], { detached: true, stdio: 'ignore',
    env: { ...process.env, PLAN_COMPANION_SOCKET: socket, PLAN_COMPANION_DATA: dirname(socket) } });
  child.on('error', error => process.stderr.write(`[task-plan companion] Launch failed: ${error.message}\n`));
  child.unref();
}

// A UI-only projection: output scores and goal bookkeeping are not UI events.
export function companionPlan(plan) {
  if (plan.parentPlanId) return null;
  const paused = plan.goalLink?.state === 'linked' && plan.goalLink.status === 'paused';
  return { id: plan.id, title: plan.title, status: plan.status,
    sourceRevision: plan.revision, createdAt: plan.createdAt,
    steps: plan.steps.map(step => ({ id: step.id, title: step.title,
      status: paused && step.status === 'in_progress' ? 'paused' : step.status,
      progress: step.progress, note: step.note, agents: step.agents ?? [] })) };
}

export function sendCompanion(socket, command, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket); let data = ''; let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(deadline); client.destroy();
      error ? reject(error) : resolve(value);
    };
    const deadline = setTimeout(() => finish(new Error('Companion timeout')), timeout);
    client.on('error', error => finish(error));
    client.on('close', () => finish(new Error('Companion disconnected')));
    client.on('connect', () => client.write(JSON.stringify(command) + '\n'));
    client.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) return finish(new Error('Companion response too large'));
      if (!data.includes('\n')) return;
      try { const result = JSON.parse(data.split('\n')[0]);
        if (!result.ok) throw new Error(result.error ?? 'Companion rejected event');
        finish(null, result);
      } catch (error) { finish(error); }
    });
  });
}

// No file/database polling. Retry delivery only while the durable outbox is nonempty.
export function companionDelivery(db, socket) {
  let running = false, retry = null, delay = 250;
  async function kick() {
    if (running || retry) return;
    running = true;
    try {
      for (;;) {
        const row = db.prepare('SELECT * FROM companion_outbox ORDER BY seq LIMIT 1').get();
        if (!row) break;
        await sendCompanion(socket, { action: 'event', selectOnCreate: Boolean(row.created),
          plan: { ...JSON.parse(row.data), revision: row.seq } });
        // Another MCP process may have replaced this pending event while we sent it.
        db.prepare('DELETE FROM companion_outbox WHERE seq=?').run(row.seq);
        delay = 250;
      }
    } catch (error) {
      process.stderr.write(`[task-plan companion] Delivery deferred: ${error.message}\n`);
      retry = setTimeout(() => { retry = null; void kick(); }, delay);
      retry.unref(); delay = Math.min(delay * 2, 30000);
    } finally { running = false; }
  }
  return { kick };
}
