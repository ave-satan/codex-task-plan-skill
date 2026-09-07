import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

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
  let queue = Promise.resolve();
  return {
    run(plans, action) {
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
          for (const [id, plan] of plans) {
            const data = JSON.stringify(plan);
            if (before.get(id) !== data) upsert.run(id, data);
          }
          db.exec('COMMIT');
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
