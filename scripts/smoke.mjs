import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callWithSnapshot } from './read-after-call.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "server.mjs")],
  cwd: root,
  env: { ...process.env, TASK_PLAN_DB: ':memory:' },
});
const client = new Client(
  { name: "codex-task-plan-smoke", version: "0.1.0" },
  {
    capabilities: {
      extensions: {
        "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
      },
    },
  },
);

await client.connect(transport);

try {
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const name of [
    "create_task_plan",
    "revise_task_plan",
    "update_task_plan_step",
    "record_task_plan_output",
    "get_task_plan",
    "show_task_plan",
    "cancel_task_plan",
  ]) {
    if (!names.has(name)) throw new Error(`Missing tool: ${name}`);
  }

  const created = await callWithSnapshot(client, {
    name: "create_task_plan",
    arguments: { title: "Smoke plan", steps: ["First", "Second"] },
  });
  const planId = created.structuredContent?.plan_id;
  if (!planId) throw new Error("create_task_plan did not return plan_id");

  const shown = await callWithSnapshot(client, {
    name: "show_task_plan",
    arguments: { plan_id: planId, view: "chip" },
  });
  if (shown.structuredContent?.view !== "chip") throw new Error("Chip view missing");
  if (shown.structuredContent?.shown_revision !== 1) throw new Error("Initial shown revision missing");

  let scored = await callWithSnapshot(client, {
    name: "record_task_plan_output",
    arguments: { plan_id: planId, points: 3 },
  });
  if (scored.structuredContent?.score !== 3 || scored.structuredContent?.should_show !== false) {
    throw new Error("Three points unexpectedly triggered a re-anchor");
  }
  scored = await callWithSnapshot(client, {
    name: "record_task_plan_output",
    arguments: { plan_id: planId, points: 1 },
  });
  if (scored.structuredContent?.score !== 4 || scored.structuredContent?.progress_changed !== false || scored.structuredContent?.should_show !== false) {
    throw new Error("Unchanged progress unexpectedly triggered a re-anchor");
  }
  const showTool = listed.tools.find((tool) => tool.name === "show_task_plan");
  const updateTool = listed.tools.find((tool) => tool.name === "update_task_plan_step");
  if (!updateTool?.inputSchema?.properties?.parallel_activity) {
    throw new Error("parallel_activity is missing from the step update schema");
  }
  const uri = showTool?._meta?.ui?.resourceUri;
  if (!uri) throw new Error("UI resource metadata missing");
  const resource = await client.readResource({ uri });
  const html = resource.contents[0];
  if (html?.mimeType !== "text/html;profile=mcp-app") throw new Error("Unexpected UI MIME type");
  for (const marker of ["get_task_plan", "progress", "`${textWidth}px`", "alignProgressBars", "previousProgress", "progress-glint", "targetProgress", "cubic-bezier(.22, .8, .3, 1)", "item.agents", "data-tooltip", "agent.dataset.tooltip", "Готово", "waiting_for_user", "Нужен ответ", "async function bootstrap", "await fetchLatestPlan()", "plan.revision < lastRevision", "shell.classList.add(\"ready\")"]) {
    if (!html.text?.includes(marker)) throw new Error(`Widget marker missing: ${marker}`);
  }
  for (const marker of ["requestClose", "closeTimer", "setTimeout", "aria-expanded", "id=\"toggle\"", "chevron", "status.title", "agent.title", ".step.in_progress { background", ".step.blocked { background", "Math.min(280", "if (initialPlan) render(initialPlan);\n      planId"] ) {
    if (html.text?.includes(marker)) throw new Error(`Widget contains a forbidden UI marker: ${marker}`);
  }
  if (!html.text?.includes("grid-template-columns: 18px minmax(0, 1fr) auto")) {
    throw new Error("Header is not aligned to the step grid");
  }
  if (html.text?.indexOf('if (item.status === "in_progress")') > html.text?.indexOf("if (item.note)")) {
    throw new Error("Progress bar must render before the step note");
  }

  const skill = await readFile(join(root, "skills/manage/SKILL.md"), "utf8");
  for (const marker of ["create_goal", "update_goal", "Set the goal objective to the plan title exactly", "Never recreate or update the goal", "revise_task_plan", "instead of creating a replacement", "record_task_plan_output", "should_show: true", "score reaches 4", "progress has changed", "Keep exactly one ordinary main-agent step active", "parallel_activity", "do not qualify as parallel work", "waiting_for_user", "direct answer or decision"]) {
    if (!skill.includes(marker)) throw new Error(`Goal lifecycle instruction missing: ${marker}`);
  }
  for (const marker of ["▤ <plan title>", "<total> этапов", "Готово, когда все этапы"]) {
    if (skill.includes(marker)) throw new Error(`Goal objective must stay compact: ${marker}`);
  }

  const firstRunning = await callWithSnapshot(client, {
    name: "update_task_plan_step",
    arguments: {
      plan_id: planId,
      step_id: "step-1",
      status: "in_progress",
      progress: 35,
      agents: [{ name: "research" }, { name: "ui_check" }],
    },
  });
  const firstStep = firstRunning.structuredContent?.plan?.steps?.[0];
  if (firstStep?.agents?.length !== 2) throw new Error("Subagent assignment was not retained");

  scored = await callWithSnapshot(client, {
    name: "record_task_plan_output",
    arguments: { plan_id: planId, points: 1 },
  });
  if (scored.structuredContent?.score !== 4 || scored.structuredContent?.progress_changed !== true || scored.structuredContent?.should_show !== true) {
    throw new Error("Changed progress at the score threshold did not trigger a re-anchor");
  }
  const reanchored = await callWithSnapshot(client, {
    name: "show_task_plan",
    arguments: { plan_id: planId, view: "full" },
  });
  if (reanchored.structuredContent?.reanchor_score !== 0 || reanchored.structuredContent?.shown_revision !== 2) {
    throw new Error("Re-anchor did not reset its score or capture the shown revision");
  }

  const parallel = await callWithSnapshot(client, {
    name: "update_task_plan_step",
    arguments: {
      plan_id: planId,
      step_id: "step-2",
      status: "in_progress",
      progress: 20,
      agents: [{ name: "tests" }],
    },
  });
  if (parallel.structuredContent?.plan?.steps?.filter((step) => step.status === "in_progress").length !== 2) {
    throw new Error("Parallel in-progress steps were not retained");
  }

  const guardedCreated = await callWithSnapshot(client, {
    name: "create_task_plan",
    arguments: { title: "Parallel guard", steps: ["Foreground", "Second foreground", "Background"] },
  });
  const guardedId = guardedCreated.structuredContent?.plan_id;
  await callWithSnapshot(client, {
    name: "update_task_plan_step",
    arguments: { plan_id: guardedId, step_id: "step-1", status: "in_progress", progress: 10 },
  });
  const rejectedPlainParallel = await callWithSnapshot(client, {
    name: "update_task_plan_step",
    arguments: { plan_id: guardedId, step_id: "step-2", status: "in_progress", progress: 10 },
  });
  if (!rejectedPlainParallel.isError) {
    throw new Error("Two ordinary main-agent steps were allowed in progress");
  }
  const backgroundParallel = await callWithSnapshot(client, {
    name: "update_task_plan_step",
    arguments: {
      plan_id: guardedId,
      step_id: "step-3",
      status: "in_progress",
      progress: 25,
      parallel_activity: "Tests are running in background",
    },
  });
  const backgroundStep = backgroundParallel.structuredContent?.plan?.steps?.[2];
  if (backgroundStep?.parallelActivity !== "Tests are running in background" || backgroundStep?.note !== "Tests are running in background") {
    throw new Error("Background parallel activity was not retained and exposed as a note");
  }
  const backgroundCompleted = await callWithSnapshot(client, {
    name: "update_task_plan_step",
    arguments: { plan_id: guardedId, step_id: "step-3", status: "completed" },
  });
  if (backgroundCompleted.structuredContent?.plan?.steps?.[2]?.parallelActivity !== "") {
    throw new Error("Completed step retained its parallel activity");
  }

  const firstCompleted = await callWithSnapshot(client, {
    name: "update_task_plan_step",
    arguments: { plan_id: planId, step_id: "step-1", status: "completed" },
  });
  if (firstCompleted.structuredContent?.plan?.steps?.[0]?.agents?.some(agent => agent.status !== "completed")) {
    throw new Error("Completed step retained active subagents");
  }
  const completed = await callWithSnapshot(client, {
    name: "update_task_plan_step",
    arguments: { plan_id: planId, step_id: "step-2", status: "completed" },
  });
  if (completed.structuredContent?.plan?.status !== "completed") {
    throw new Error("Plan did not auto-complete");
  }
  const retained = await callWithSnapshot(client, {
    name: "get_task_plan",
    arguments: { plan_id: planId },
  });
  if (retained.structuredContent?.plan?.status !== "completed") {
    throw new Error("Completed plan was not retained");
  }

  for (const request of [
    { name: "revise_task_plan", arguments: { plan_id: planId, add_steps: ["New work"] } },
    { name: "revise_task_plan", arguments: { plan_id: planId, title: "Reused plan" } },
    { name: "update_task_plan_step", arguments: { plan_id: planId, step_id: "step-1", status: "in_progress" } },
    { name: "cancel_task_plan", arguments: { plan_id: planId } },
  ]) {
    const rejected = await callWithSnapshot(client, request);
    if (!rejected.isError || !JSON.stringify(rejected.content).includes("read-only")) {
      throw new Error(`Completed plan mutation was not rejected: ${request.name}`);
    }
  }
  const unchanged = await callWithSnapshot(client, { name: "get_task_plan", arguments: { plan_id: planId } });
  if (JSON.stringify(unchanged.structuredContent.plan) !== JSON.stringify(retained.structuredContent.plan)) {
    throw new Error("Rejected mutations changed completed plan history");
  }
  const fresh = await callWithSnapshot(client, {
    name: "create_task_plan", arguments: { title: "Fresh revision plan", steps: ["First", "Second"] },
  });
  const revisionPlanId = fresh.structuredContent.plan.id;
  if (revisionPlanId === planId) throw new Error("New work reused the completed plan ID");
  const revised = await callWithSnapshot(client, {
    name: "revise_task_plan",
    arguments: {
      plan_id: revisionPlanId,
      title: "Revised smoke plan",
      rename_steps: [{ step_id: "step-1", title: "Renamed first" }],
      add_steps: ["New scope"],
    },
  });
  const addedStepId = revised.structuredContent?.added_steps?.[0]?.id;
  if (revised.structuredContent?.plan?.title !== "Revised smoke plan" || revised.structuredContent?.plan?.status !== "active" || revised.structuredContent?.plan?.total !== 3 || !addedStepId) {
    throw new Error("Active plan revision did not rename and add as expected");
  }
  const reordered = await callWithSnapshot(client, {
    name: "revise_task_plan",
    arguments: {
      plan_id: revisionPlanId,
      order: [addedStepId, "step-1", "step-2"],
    },
  });
  if (reordered.structuredContent?.plan?.steps?.[0]?.id !== addedStepId) {
    throw new Error("Plan steps were not reordered");
  }
  for (const stepId of ["step-1", "step-2"]) {
    await callWithSnapshot(client, { name: "update_task_plan_step", arguments: {
      plan_id: revisionPlanId, step_id: stepId, status: "completed",
    } });
  }
  const trimmed = await callWithSnapshot(client, {
    name: "revise_task_plan",
    arguments: { plan_id: revisionPlanId, remove_step_ids: [addedStepId] },
  });
  if (trimmed.structuredContent?.plan?.status !== "completed" || trimmed.structuredContent?.plan?.total !== 2) {
    throw new Error("Removing a pending revision step did not restore completion");
  }
  const rejectedRemoval = await callWithSnapshot(client, {
    name: "revise_task_plan",
    arguments: { plan_id: planId, remove_step_ids: ["step-1"] },
  });
  if (!rejectedRemoval.isError) throw new Error("Removing a completed step was not rejected");

  const parentCreated = await callWithSnapshot(client, {
    name: "create_task_plan",
    arguments: { title: "Parent plan", steps: ["Delegated work", "Wrap up"] },
  });
  const parentId = parentCreated.structuredContent?.plan_id;
  const childACreated = await callWithSnapshot(client, {
    name: "create_task_plan",
    arguments: {
      title: "Child A",
      steps: ["A1", "A2"],
      parent_plan_id: parentId,
      parent_step_id: "step-1",
    },
  });
  const childBCreated = await callWithSnapshot(client, {
    name: "create_task_plan",
    arguments: {
      title: "Child B",
      steps: ["B1", "B2"],
      parent_plan_id: parentId,
      parent_step_id: "step-1",
    },
  });
  const childAId = childACreated.structuredContent?.plan_id;
  const childBId = childBCreated.structuredContent?.plan_id;
  let parent = await callWithSnapshot(client, {
    name: "get_task_plan",
    arguments: { plan_id: parentId },
  });
  let linkedStep = parent.structuredContent?.plan?.steps?.[0];
  if (linkedStep?.status !== "in_progress" || linkedStep?.progress !== 0 || linkedStep?.childPlans?.length !== 2) {
    throw new Error("Parallel subplans were not linked to the parent step");
  }

  for (const stepId of ["step-1", "step-2"]) {
    await callWithSnapshot(client, {
      name: "update_task_plan_step",
      arguments: { plan_id: childAId, step_id: stepId, status: "completed" },
    });
  }
  await callWithSnapshot(client, {
    name: "update_task_plan_step",
    arguments: { plan_id: childBId, step_id: "step-1", status: "completed" },
  });
  await callWithSnapshot(client, {
    name: "update_task_plan_step",
    arguments: { plan_id: childBId, step_id: "step-2", status: "in_progress", progress: 50 },
  });
  parent = await callWithSnapshot(client, {
    name: "get_task_plan",
    arguments: { plan_id: parentId },
  });
  linkedStep = parent.structuredContent?.plan?.steps?.[0];
  if (linkedStep?.status !== "in_progress" || linkedStep?.progress !== 88) {
    throw new Error(`Unexpected aggregate subplan progress: ${linkedStep?.progress}`);
  }

  await callWithSnapshot(client, {
    name: "update_task_plan_step",
    arguments: { plan_id: childBId, step_id: "step-2", status: "completed" },
  });
  parent = await callWithSnapshot(client, {
    name: "get_task_plan",
    arguments: { plan_id: parentId },
  });
  linkedStep = parent.structuredContent?.plan?.steps?.[0];
  if (linkedStep?.status !== "completed" || linkedStep?.progress !== 100) {
    throw new Error("Completed subplans did not complete their parent step");
  }

  const childRevised = await callWithSnapshot(client, {
    name: "revise_task_plan",
    arguments: { plan_id: childBId, add_steps: ["B3"] },
  });
  if (!childRevised.isError) throw new Error("Completed subplan was reopened");
  parent = await callWithSnapshot(client, {
    name: "get_task_plan",
    arguments: { plan_id: parentId },
  });
  linkedStep = parent.structuredContent?.plan?.steps?.[0];
  if (linkedStep?.status !== "completed" || linkedStep?.progress !== 100) {
    throw new Error("Rejected subplan revision changed parent completion");
  }

  const blockedParentCreated = await callWithSnapshot(client, {
    name: "create_task_plan",
    arguments: { title: "Blocked parent", steps: ["Delegated work", "Wrap up"] },
  });
  const blockedParentId = blockedParentCreated.structuredContent?.plan_id;
  const cancelledChildCreated = await callWithSnapshot(client, {
    name: "create_task_plan",
    arguments: {
      title: "Cancelled child",
      steps: ["C1", "C2"],
      parent_plan_id: blockedParentId,
      parent_step_id: "step-1",
    },
  });
  await callWithSnapshot(client, {
    name: "cancel_task_plan",
    arguments: { plan_id: cancelledChildCreated.structuredContent?.plan_id },
  });
  const blockedParent = await callWithSnapshot(client, {
    name: "get_task_plan",
    arguments: { plan_id: blockedParentId },
  });
  if (blockedParent.structuredContent?.plan?.steps?.[0]?.status !== "blocked") {
    throw new Error("Cancelled subplan did not block its parent step");
  }

  console.log("Smoke test passed: sequential main-agent guard, honest parallel work, layout, animation, revision, and linked plans are valid.");
} finally {
  await client.close();
}
