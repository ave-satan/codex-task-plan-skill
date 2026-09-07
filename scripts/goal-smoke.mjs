import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readGoal } from "../goal-reader.mjs";
import { callWithSnapshot } from './read-after-call.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = await mkdtemp(join(tmpdir(), "task-plan-goal-test-"));
const database = join(fixture, "goals_1.sqlite");
const db = new DatabaseSync(database);
db.exec("CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT)");
const thread = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const client = new Client({ name: "goal-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath, args: [join(root, "server.mjs")],
  env: { ...process.env, CODEX_HOME: fixture, CODEX_SQLITE_HOME: fixture }, cwd: root,
});
const call = async (name, args) => {
  const result = await callWithSnapshot(client, { name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent;
};
try {
  await client.connect(transport);
  const unbound = await call("create_task_plan", {title: "Unbound fixture", steps: ["Work", "Check"]});
  assert.ok(unbound.next_action);
  const recovered = await call("get_task_plan", {plan_id: unbound.plan_id, thread_id: thread});
  assert.equal(recovered.plan.goal.state, "waiting");
  const update = (args) => call("update_task_plan_step", {plan_id: unbound.plan_id, step_id: "step-1", status: "in_progress", ...args});
  assert.equal((await update({})).plan.steps[0].progress, null);
  assert.equal((await update({progress: 0})).plan.steps[0].progress, 0);
  assert.equal((await update({progress: 42})).plan.steps[0].progress, 42);
  assert.equal((await update({note: "Checkpoint"})).plan.steps[0].progress, 42);
  assert.equal((await update({progress: null})).plan.progress, null);
  assert.equal((await update({status: "completed"})).plan.steps[0].progress, 100);
  assert.equal((await update({})).plan.steps[0].progress, null);
  const created = await call("create_task_plan", {title: "Goal fixture", steps: ["Work", "Check"], thread_id: thread});
  const plan_id = created.plan_id;
  const get = async () => (await call("get_task_plan", {plan_id})).plan;
  assert.equal(created.plan.goal.state, "waiting");
  db.prepare("INSERT INTO thread_goals VALUES(?,?,?,?)").run(other, "other-goal", "Goal fixture", "paused");
  assert.equal((await get()).goal.state, "waiting", "Must not bind a neighboring goal");
  db.prepare("INSERT INTO thread_goals VALUES(?,?,?,?)").run(thread, "original", "Goal fixture", "active");
  assert.equal((await get()).goal.status, "active");
  assert.equal((await call("get_task_plan", {plan_id})).next_action, null);
  await call("update_task_plan_step", {plan_id, step_id: "step-1", status: "in_progress", progress: 42});
  await call("show_task_plan", {plan_id});
  const baseline = await get();
  for (const status of ["paused", "active", "blocked", "usage_limited", "budget_limited", "complete"]) {
    db.prepare("UPDATE thread_goals SET status=? WHERE thread_id=?").run(status, thread);
    const plan = await get();
    assert.equal(plan.goal.status, status);
    assert.deepEqual(plan.steps, baseline.steps);
    assert.equal(plan.revision, baseline.revision);
    assert.equal(plan.status, "active", "Goal completion must not fabricate step completion");
  }
  const score = await call("record_task_plan_output", {plan_id, points: 3});
  assert.equal(score.progress_changed, false);
  db.prepare("UPDATE thread_goals SET objective='Edited objective' WHERE thread_id=?").run(thread);
  assert.equal((await get()).goal.state, "linked");
  db.prepare("UPDATE thread_goals SET goal_id='replacement', objective='Goal fixture' WHERE thread_id=?").run(thread);
  assert.equal((await get()).goal.state, "detached");
  assert.equal((await get()).goal.status, null);
  const next = await call("create_task_plan", {title: "Goal fixture", steps: ["Work", "Check"], thread_id: thread});
  assert.equal(next.plan.goal.state, "linked");
  db.prepare("DELETE FROM thread_goals WHERE thread_id=?").run(thread);
  assert.equal((await call("get_task_plan", {plan_id: next.plan_id})).plan.goal.state, "detached");
  assert.equal(readGoal(thread, join(fixture, "missing.sqlite")).available, false);
  db.exec("DROP TABLE thread_goals");
  assert.equal(readGoal(thread, database).available, false);
  console.log("Goal smoke passed: binding, isolation, pause/resume, limits, completion, replacement, clearing, and unavailable storage.");
} finally {
  await client.close();
  db.close();
  await rm(fixture, {recursive: true, force: true});
}
