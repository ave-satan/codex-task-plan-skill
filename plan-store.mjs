import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { companionPlan, companionDelivery, launchCompanionForCreation } from './companion-bridge.mjs';

// Outside the versioned plugin cache. Each MCP process shares this database.
export function openPlanStore() {
  const path = process.env.TASK_PLAN_DB ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'task-plan', 'plans.sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=10000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) throw new Error(`Unsupported task plan storage version: ${version}`);
  db.exec('CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version=1;');
  const upsert = db.prepare('INSERT INTO plans(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
  const socket = process.env.TASK_PLAN_COMPANION_SOCKET;
  const source = createHash('sha256').update(path).digest('hex').slice(0, 16);
  if (socket) db.exec('CREATE TABLE IF NOT EXISTS companion_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL)');
  const delivery = socket ? companionDelivery(db, socket) : null;
  delivery?.kick();
  let queue = Promise.resolve();
  return {
    run(plans, action, showPlanId = null) {
      const operation = queue.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          plans.clear();
          const before = new Map();
          for (const row of db.prepare('SELECT id,data FROM plans').all()) {
            const plan = JSON.parse(row.data);
            if (plan.id !== row.id || !Array.isArray(plan.steps)) throw new Error('Invalid task plan storage record');
            plans.set(row.id, plan); before.set(row.id, row.data);
          }
          const result = await action();
          let createdRoot = false;
          for (const [id, plan] of plans) {
            const data = JSON.stringify(plan);
            if (before.get(id) !== data) upsert.run(id, data);
            if (socket) {
              const projected = companionPlan(plan);
              const prior = before.has(id) ? companionPlan(JSON.parse(before.get(id))) : null;
              if (projected && !prior) createdRoot = true;
              if (projected && (JSON.stringify(projected) !== JSON.stringify(prior) || id === showPlanId)) {
                const pending = db.prepare('SELECT created,data FROM companion_outbox WHERE plan_id=?').get(id);
                db.prepare('DELETE FROM companion_outbox WHERE plan_id=?').run(id);
                const inserted = db.prepare('INSERT INTO companion_outbox(plan_id,data,created) VALUES(?,?,?)')
                  .run(id, JSON.stringify(projected), pending?.created || (!prior ? 1 : 0));
                projected.source = source;
                projected.creationSequence = pending ? JSON.parse(pending.data).creationSequence : (!prior ? Number(inserted.lastInsertRowid) : 0);
                db.prepare('UPDATE companion_outbox SET data=? WHERE seq=?').run(JSON.stringify(projected), inserted.lastInsertRowid);
              }
            }
          }
          db.exec('COMMIT');
          // One launch attempt only for a newly COMMITTED root, never a replay/read/update.
          if (socket && createdRoot) void launchCompanionForCreation(socket);
          // Never hold the transaction or delay the agent on a UI connection.
          delivery?.kick();
          return result;
        } catch (error) {
          db.exec('ROLLBACK'); plans.clear(); throw error;
        }
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
