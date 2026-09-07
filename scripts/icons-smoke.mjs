import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
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
  const fixturePlan = structuredClone(plan);
  const completed = await call("update_task_plan_step", { plan_id: plan.id,
    step_id: "step-1", status: "completed" });
  assert.deepEqual(completed.steps[0].agents, []);

  // Linked steps keep agent categories while deriving their own progress.
  const child = await call("create_task_plan", { title: "Child", steps: ["A", "B"],
    parent_plan_id: plan.id, parent_step_id: "step-2" });
  const parent = await call("update_task_plan_step", { plan_id: plan.id, step_id: "step-2",
    status: "in_progress", agents: [{ name: "architect", category: "architecture" }] });
  assert.equal(parent.steps[1].agents[0].category, "architecture");
  assert.equal(parent.steps[1].childPlans[0].id, child.id);

  const uri = tools.find(t => t.name === "show_task_plan")._meta.ui.resourceUri;
  const resource = await client.readResource({ uri });
  assert.equal(resource.contents[0]._meta?.["openai/widgetMinFrameHeight"], 0);
  const html = resource.contents[0].text;
  assert.ok(html.includes('class="status-gear"'));
  assert.ok(html.includes('.step-head .progress { grid-row: 2; }'));
  assert.ok(html.includes('.goal-stopped .status-gear { animation-play-state: paused; }'));
  assert.ok(!html.includes('.in_progress .agent { animation:'));
  assert.ok(!html.includes('.in_progress .agent-gear { animation:'));
  for (const category of expected) {
    assert.ok(html.includes(`--agent-motion: agent-${category};`), `motion mapping: ${category}`);
    assert.ok(html.includes(`@keyframes agent-${category} {`), `motion frames: ${category}`);
  }
  assert.ok(html.includes('.in_progress .agent > img {'));
  assert.ok(html.includes('.goal-stopped .in_progress .agent > img { animation-play-state: paused; }'));
  assert.ok(html.includes('.in_progress .agent:hover > img, .in_progress .agent:focus-visible > img,'));
  assert.ok(html.includes('prefers-reduced-motion: reduce'));
  assert.ok(html.includes('agent-breathe 2.5s ease-in-out infinite'));
  assert.ok(html.includes('@keyframes agent-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }'));
  assert.ok(!html.includes('@keyframes agent-pulse'));
  assert.ok(html.includes('agent.style.setProperty("--agent-phase"'));
  assert.ok(html.includes('icon.width = 24;'));
  assert.ok(html.includes('`${categoryIcon?.label ?? "Субагент"} · ${displayName}`'));
  const header = html.match(/class="plan-icon"[^>]*><img src="data:image\/png;base64,([^"]+)"/);
  assert.ok(header, "Header embeds the duck PNG");
  assert.deepEqual(Buffer.from(header[1], "base64"), await readFile(join(root, "assets/duck-foreman.png")));
  assert.ok(!html.includes("__PLAN_HEADER_ICON__"));
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
  if (process.argv[2]) {
    fixturePlan.goal = { state: "linked", availability: "available", status: "active" };
    const state = JSON.stringify(fixturePlan).replaceAll("<", "\\u003c");
    const fixture = `<script>
      let fixturePlan = ${state};
      window.openai = { toolOutput: { plan: fixturePlan },
        callTool: async () => ({ plan: fixturePlan }), notifyIntrinsicHeight: () => {} };
      function publish() { window.dispatchEvent(new CustomEvent('openai:set_globals',
        {detail:{globals:{toolOutput:{plan:fixturePlan}}}})); }
      function setGoal(status) { fixturePlan.goal.status=status; publish(); }
      function reclassify() { fixturePlan.steps[0].agents[0].category='review'; fixturePlan.revision++; publish(); }
      function legacyAgent() { delete fixturePlan.steps[0].agents[0].category; fixturePlan.revision++; publish(); }
      function longStep() { fixturePlan.steps[0].title='Проверить перенос длинного названия этапа без смещения иконки относительно текста и полосы прогресса'; fixturePlan.steps[0].agents=[{name:'researcher',category:'research'},{name:'reviewer',category:'review'},{name:'tester',category:'testing'}]; fixturePlan.revision++; publish(); }
    </script><style>html{color-scheme:dark;background:#111}body{max-width:880px;margin:24px auto;padding:16px}nav{margin-bottom:20px;display:flex;gap:12px;flex-wrap:wrap}button{padding:6px 10px}</style>`;
    const controls = `<nav><button onclick="setGoal('paused')">Пауза</button><button onclick="setGoal('active')">Продолжить</button><button onclick="reclassify()">Сменить категорию</button><button onclick="legacyAgent()">Без категории</button><button onclick="longStep()">Длинный шаг</button><button onclick="document.documentElement.style.colorScheme='light';document.documentElement.style.background='#fff'">Светлая тема</button></nav>`;
    await writeFile(process.argv[2], html.replace("</head>", fixture + "</head>").replace("<body>", "<body>" + controls));
  }
  console.log("Icons smoke passed: 10 categories, retained state, validation, legacy, completion, subplan, 10 embedded RGBA assets.");
} finally { await client.close(); }
