import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Outside the versioned plugin cache. Each MCP process shares this database.
export function openPlanStore() {
  const path = process.env.TASK_PLAN_DB ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'task-plan', 'plans.sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=10000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) throw new Error(`Unsupported task plan storage version: ${version}`);
  db.exec('CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version=1;');
  db.exec('CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO store_meta(key,value) VALUES(?,?)').run('generation', randomUUID());
  db.prepare('INSERT OR IGNORE INTO store_meta(key,value) VALUES(?,?)').run('revision', '0');
  const generation = db.prepare('SELECT value FROM store_meta WHERE key=?').get('generation').value;
  const upsert = db.prepare('INSERT INTO plans(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
  // Retire only an empty legacy outbox. Leave any undelivered data recoverable.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_outbox'").get()
        && !db.prepare('SELECT 1 FROM companion_outbox LIMIT 1').get()) {
      db.exec('DROP TABLE companion_outbox');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  let queue = Promise.resolve();
  db.exec('CREATE TABLE IF NOT EXISTS panel_receipts (thread_id TEXT NOT NULL, instance_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(thread_id, instance_id))');
  db.exec('CREATE TABLE IF NOT EXISTS panel_presence (thread_id TEXT PRIMARY KEY, instance_id TEXT, seen_at INTEGER NOT NULL DEFAULT 0, opening_until INTEGER NOT NULL DEFAULT 0)');
  const pruneCompleted = () => {
    const roots = db.prepare(`SELECT id,data FROM plans
      WHERE json_extract(data,'$.parentPlanId') IS NULL
        AND json_extract(data,'$.status') IN ('completed','cancelled')
        AND julianday(json_extract(data,'$.completedAt')) <= julianday('now', '-30 seconds')`).all();
    for (const row of roots) {
      const plan = JSON.parse(row.data);
      const thread = (plan.threadId ?? plan.goalLink?.threadId)?.toLowerCase();
      if (thread) {
        // Keep only the ordering boundary so an older root cannot reappear.
        const key = 'panel_retired_before:' + thread;
        const boundary = { at: plan.createdAt, sequence: plan.createdSequence ?? 0, id: plan.id };
        const prior = db.prepare('SELECT value FROM store_meta WHERE key=?').get(key);
        const previous = prior && JSON.parse(prior.value);
        if (!previous || boundary.at > previous.at || (boundary.at === previous.at
            && (boundary.sequence > previous.sequence || (boundary.sequence === previous.sequence && boundary.id > previous.id)))) {
          db.prepare('INSERT INTO store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(key, JSON.stringify(boundary));
        }
      }
      db.prepare(`WITH RECURSIVE retired(id) AS (
        SELECT ? UNION SELECT p.id FROM plans p JOIN retired r ON json_extract(p.data,'$.parentPlanId')=r.id
      ) DELETE FROM plans WHERE id IN retired`).run(row.id);
      if (thread) db.prepare(`DELETE FROM panel_receipts WHERE thread_id=? AND EXISTS (
        SELECT 1 FROM json_each(panel_receipts.data,'$.history') h WHERE json_extract(h.value,'$.plan_id')=?
      )`).run(thread, row.id);
    }
    return roots.length > 0;
  };
  setInterval(() => {
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (pruneCompleted()) db.exec("UPDATE store_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } catch (error) { console.error('Task Plan cleanup failed:', error.message); }
  }, 30_000).unref();
  const presence = threadId => {
    const row = db.prepare('SELECT instance_id,seen_at,opening_until FROM panel_presence WHERE thread_id=?').get(threadId);
    const now = Date.now();
    return { active: Boolean(row?.instance_id && now - row.seen_at < 15000),
      opening: Boolean(row?.opening_until > now), instance_id: row?.instance_id ?? null };
  };
  const chatPresence = threadId => {
    const inline = presence(threadId);
    const tab = presence(threadId + ':tab');
    return inline.active || !tab.active ? inline : tab;
  };
  return {
    panelPresence: chatPresence,
    claimPanelOpen(threadId) {
      const current = presence(threadId);
      if (current.active || current.opening) return { ...current, should_open: false };
      db.prepare('INSERT INTO panel_presence(thread_id,instance_id,seen_at,opening_until) VALUES(?,NULL,0,?) ON CONFLICT(thread_id) DO UPDATE SET instance_id=NULL,seen_at=0,opening_until=excluded.opening_until')
        .run(threadId, Date.now() + 15000);
      const token = randomUUID();
      db.prepare('INSERT INTO store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('panel_open:' + threadId, token);
      return { active: false, opening: true, instance_id: null, should_open: true, open_token: token };
    },
    consumePanelOpen(threadId, token) {
      const state = presence(threadId);
      const stored = db.prepare('SELECT value FROM store_meta WHERE key=?').get('panel_open:' + threadId);
      if (state.active || !state.opening || stored?.value !== token) return false;
      db.prepare('DELETE FROM store_meta WHERE key=?').run('panel_open:' + threadId);
      return true;
    },
    touchPanel(threadId, instanceId, tab) {
      const key = tab ? threadId + ":tab" : threadId;
      const current = presence(key);
      if (current.active && current.instance_id !== instanceId) return false;
      db.prepare('INSERT INTO panel_presence(thread_id,instance_id,seen_at,opening_until) VALUES(?,?,?,0) ON CONFLICT(thread_id) DO UPDATE SET instance_id=excluded.instance_id,seen_at=excluded.seen_at,opening_until=0')
        .run(key, instanceId, Date.now());
      if (!tab) db.prepare('DELETE FROM store_meta WHERE key=?').run('panel_open:' + threadId);
      return true;
    },
    releasePanel(threadId, instanceId) {
      db.prepare('UPDATE panel_presence SET instance_id=NULL,seen_at=0 WHERE thread_id IN (?,?) AND instance_id=?').run(threadId, threadId + ":tab", instanceId);
    },
    nextPlanSequence() {
      const row = db.prepare('SELECT value FROM store_meta WHERE key=?').get('plan_sequence');
      const next = Number(row?.value ?? 0) + 1;
      db.prepare('INSERT INTO store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('plan_sequence', String(next));
      return next;
    },
    recordPanelReceipt(threadId, value) {
      const previous = db.prepare('SELECT data FROM panel_receipts WHERE thread_id=? AND instance_id=?').get(threadId, value.instance_id);
      const prior = previous ? JSON.parse(previous.data) : null;
      const history = [...(prior?.history ?? []), { plan_id: value.plan_id ?? null, revision: value.revision ?? null, counter: value.counter }].slice(-8);
      const at = new Date().toISOString();
      db.prepare('INSERT INTO panel_receipts(thread_id,instance_id,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(thread_id,instance_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at')
        .run(threadId, value.instance_id, JSON.stringify({ ...value, thread_id: threadId, history, at }), at);
      db.prepare('DELETE FROM panel_receipts WHERE thread_id=? AND instance_id NOT IN (SELECT instance_id FROM panel_receipts WHERE thread_id=? ORDER BY updated_at DESC LIMIT 20)').run(threadId, threadId);
    },
    panelReceipts(threadId) {
      return db.prepare('SELECT data FROM panel_receipts WHERE thread_id=? ORDER BY updated_at DESC LIMIT 10').all(threadId).map(row => JSON.parse(row.data));
    },
    run(plans, action, { stampSnapshot = false, ...options } = {}) {
      const operation = queue.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const pruned = pruneCompleted();
          plans.clear();
          const before = new Map();
          const rows = Object.hasOwn(options, 'scopeThreadId')
            ? options.scopeThreadId ? db.prepare(`WITH RECURSIVE selected(id,data) AS (
                SELECT id,data FROM (SELECT id,data FROM plans
                  WHERE json_extract(data,'$.parentPlanId') IS NULL
                    AND lower(coalesce(json_extract(data,'$.threadId'),json_extract(data,'$.goalLink.threadId'))) = ?
                    AND NOT EXISTS (SELECT 1 FROM store_meta m WHERE m.key='panel_retired_before:' || ?
                      AND (json_extract(plans.data,'$.createdAt'), coalesce(json_extract(plans.data,'$.createdSequence'),0), plans.id)
                        <= (json_extract(m.value,'$.at'), json_extract(m.value,'$.sequence'), json_extract(m.value,'$.id')))
                  ORDER BY json_extract(data,'$.createdAt') DESC, coalesce(json_extract(data,'$.createdSequence'),0) DESC, id DESC LIMIT 1)
                UNION ALL SELECT p.id,p.data FROM plans p JOIN selected parent ON json_extract(p.data,'$.parentPlanId') = parent.id
              ) SELECT id,data FROM selected`).all(options.scopeThreadId, options.scopeThreadId) : []
            : db.prepare('SELECT id,data FROM plans').all();
          for (const row of rows) {
            const plan = JSON.parse(row.data);
            if (plan.id !== row.id || !Array.isArray(plan.steps)) throw new Error('Invalid task plan storage record');
            plans.set(row.id, plan); before.set(row.id, row.data);
          }
          const result = await action();
          let changed = pruned;
          for (const [id, plan] of plans) {
            const data = JSON.stringify(plan);
            if (before.get(id) !== data) { upsert.run(id, data); changed = true; }
          }
          let revision = Number(db.prepare('SELECT value FROM store_meta WHERE key=?').get('revision').value);
          if (changed) {
            revision += 1;
            db.prepare('UPDATE store_meta SET value=? WHERE key=?').run(String(revision), 'revision');
          }
          if (stampSnapshot) result.structuredContent.storeVersion = { generation, revision };
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
