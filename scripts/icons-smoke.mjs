import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callWithSnapshot } from './read-after-call.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = ["research", "architecture", "design", "implementation", "diagnostics",
  "testing", "review", "data", "documentation", "operations"];
const transport = new StdioClientTransport({ command: process.execPath,
  args: [join(root, "server.mjs")], cwd: root, env: { ...process.env, TASK_PLAN_DB: ':memory:' } });
const client = new Client({ name: "icons-smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
const call = async (name, args) => {
  const result = await callWithSnapshot(client, { name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.structuredContent.plan;
};
try {
  const { tools } = await client.listTools();
  const categorySchema = tools.find(t => t.name === "update_task_plan_step")
    .inputSchema.properties.agents.items.properties.category;
  assert.deepEqual(categorySchema.enum, expected);
  const statusSchema = tools.find(t => t.name === "update_task_plan_step").inputSchema.properties.status;
  assert.ok(statusSchema.enum.includes("waiting_for_user"));
  let plan = await call("create_task_plan", { title: "Иконки агентов · синтетическая проверка",
    steps: expected.map(id => `Проверить категорию ${id}`) });
  for (let i = 0; i < expected.length; i++) {
    plan = await call("update_task_plan_step", { plan_id: plan.id,
      step_id: `step-${i + 1}`, status: "in_progress", progress: 35,
      agents: [{ name: `synthetic-${i}`, category: expected[i] }] });
    assert.deepEqual(plan.steps[i].agents, [{ name: `synthetic-${i}`, category: expected[i] }]);
  }
  plan = await call("update_task_plan_step", { plan_id: plan.id, step_id: "step-1",
    status: "in_progress", progress: 62, note: "Тест сохранения категории" });
  assert.deepEqual(plan.steps[0].agents, [{ name: "synthetic-0", category: "research" }]);
  const before = structuredClone(plan);
  const rejected = await callWithSnapshot(client, { name: "update_task_plan_step", arguments: {
    plan_id: plan.id, step_id: "step-1", status: "in_progress",
    agents: [{ name: "invalid", category: "__proto__" }] } });
  assert.equal(rejected.isError, true);
  plan = await call("get_task_plan", { plan_id: plan.id });
  assert.deepEqual(plan, before, "Invalid categories must not mutate the plan");
  const legacy = await call("update_task_plan_step", { plan_id: plan.id, step_id: "step-1",
    status: "in_progress", agents: [{ name: "legacy" }] });
  assert.deepEqual(legacy.steps[0].agents, [{ name: "legacy" }]);
  plan = await call("update_task_plan_step", { plan_id: plan.id, step_id: "step-1",
    status: "in_progress", agents: [{ name: "researcher", category: "research" }] });
  const completed = await call("update_task_plan_step", { plan_id: plan.id,
    step_id: "step-1", status: "completed" });
  assert.deepEqual(completed.steps[0].agents, [{ name: "researcher", category: "research", status: "completed" }]);
  const mixed = await call("update_task_plan_step", {plan_id: plan.id, step_id: "step-2", status: "in_progress",
    agents: [{name:"finished",category:"review",status:"completed"},{name:"running",category:"testing",status:"working"}]});
  assert.equal(mixed.steps[1].agents[0].status,"completed");
  assert.equal(mixed.steps[1].agents[1].status,"working");
  const guard = await call("create_task_plan", {title:"Completed agents are not concurrency",steps:["Main","Other"]});
  await call("update_task_plan_step", {plan_id:guard.id,step_id:"step-1",status:"in_progress"});
  const question = await call("update_task_plan_step", {plan_id:guard.id,step_id:"step-1",
    status:"waiting_for_user",note:"Какой вариант выбрать?"});
  assert.equal(question.steps[0].status,"waiting_for_user");
  assert.equal(question.steps[0].note,"Какой вариант выбрать?");
  assert.equal(question.finished,0);
  await call("update_task_plan_step", {plan_id:guard.id,step_id:"step-1",status:"in_progress"});
  const denied = await client.callTool({name:"update_task_plan_step",arguments:{plan_id:guard.id,step_id:"step-2",status:"in_progress",agents:[{name:"done",status:"completed"}]}});
  assert.equal(denied.isError,true);

  // Linked steps keep agent categories while deriving their own progress.
  const child = await call("create_task_plan", { title: "Child", steps: ["A", "B"],
    parent_plan_id: plan.id, parent_step_id: "step-2" });
  const parent = await call("update_task_plan_step", { plan_id: plan.id, step_id: "step-2",
    status: "in_progress", agents: [{ name: "architect", category: "architecture" }] });
  assert.equal(parent.steps[1].agents[0].category, "architecture");
  assert.equal(parent.steps[1].childPlans[0].id, child.id);

  const uri = tools.find(t => t.name === "open_task_plan_panel")._meta.ui.resourceUri;
  const resource = await client.readResource({ uri });
  assert.equal(resource.contents[0]._meta?.["openai/widgetMinFrameHeight"], 0);
  const html = resource.contents[0].text;
  assert.ok(!html.includes("/*__WORK_CATEGORY_ICONS__*/"));
  const icons = JSON.parse(html.match(/const categoryIcons = (.+);/)[1]);
  assert.deepEqual(Object.keys(icons), expected);
  for (const id of expected) {
    const bytes = Buffer.from(icons[id].src.split(",")[1], "base64");
    assert.equal(icons[id].src.startsWith("data:image/png;base64,"), true);
    assert.deepEqual(bytes, await readFile(join(root, "assets/agent-icons", `${id}.png`)));
    assert.equal(bytes.readUInt32BE(16), 48);
    assert.equal(bytes.readUInt32BE(20), 48);
    assert.equal(bytes[25], 6, "RGBA color type expected");
  }
  console.log("Icons smoke passed: 10 categories, retained state, validation, legacy, completion, subplan, 10 embedded RGBA assets.");
} finally { await client.close(); }
