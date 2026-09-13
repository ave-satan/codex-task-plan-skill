import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppResource,
  registerAppTool as registerTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { readGoal, syncGoalLink } from "./goal-reader.mjs";
import { workCategories, workCategoryIds } from "./work-categories.mjs";
import { openPlanStore } from "./plan-store.mjs";
import { sendCompanion } from "./companion-bridge.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const categoryIcons = Object.fromEntries(await Promise.all(workCategories.map(async ({ id, label }) => [
  id, { label, src: `data:image/png;base64,${(await readFile(join(root, "assets", "agent-icons", `${id}.png`))).toString("base64")}` },
])));
const widgetHtml = (await readFile(join(root, "widget.html"), "utf8"))
  .replace("__PLAN_HEADER_ICON__", `data:image/png;base64,${(await readFile(join(root, "assets", "duck-foreman.png"))).toString("base64")}`)
  .replace("/*__WORK_CATEGORY_ICONS__*/ {}", JSON.stringify(categoryIcons).replaceAll("<", "\\u003c"));
const widgetUri = "ui://codex-task-plan/plan.html";
const plans = new Map();
const store = openPlanStore();
const companionSocket = process.env.TASK_PLAN_COMPANION_SOCKET;
const companionMode = Boolean(companionSocket);
function registerAppTool(server, name, config, handler) {
  return registerTool(server, name, config, (...args) => store.run(plans, () => {
    if (["update_task_plan_step", "revise_task_plan", "cancel_task_plan"].includes(name)) {
      let plan = requirePlan(args[0].plan_id);
      while (plan) {
        if (plan.status === "completed") {
          throw new Error("Completed task plans are read-only. Create a new plan for new work; do not reuse or reopen a completed plan.");
        }
        plan = plan.parentPlanId ? requirePlan(plan.parentPlanId) : null;
      }
    }
    return handler(...args);
  }, name === 'show_task_plan' ? args[0].plan_id : null));
}
const reanchorThreshold = 4;

const statuses = ["pending", "in_progress", "waiting_for_user", "completed", "blocked", "skipped"];
const agentSchema = z.object({
  name: z.string().min(1).max(80),
  status: z.enum(["working", "completed"]).optional().describe("Assignment state, maintained by the main agent. Set completed when this subagent finishes; its icon stays still. Omitted means working for legacy entries."),
  category: z.enum(workCategoryIds).optional().describe(
    "Choose by the current assignment's primary deliverable, not the agent name or a workflow calling all outputs reviews, without an extra model call. Creating alternatives or arbitrating architecture is architecture; gathering evidence is research; critiquing an existing proposal is review. "
    + workCategories.map(({ id, task }) => `${id}: ${task}`).join("; ")
    + ". Omit only for an old assignment whose task is unknown."
  ),
});
const renamedStepSchema = z.object({
  step_id: z.string().min(1),
  title: z.string().min(1).max(180),
});

function stepProgress(step) {
  if (step.status === "completed" || step.status === "skipped") return 100;
  if (step.status === "in_progress") return step.progress;
  return 0;
}

function planProgress(plan) {
  if (!plan.steps.length) return 0;
  if (plan.steps.some((step) => stepProgress(step) === null)) return null;
  return Math.round(
    plan.steps.reduce((total, step) => total + stepProgress(step), 0) / plan.steps.length,
  );
}

function isMainAgentForegroundStep(step) {
  return step.status === "in_progress"
    && !step.agents.some(agent => agent.status !== "completed")
    && !step.parallelActivity
    && step.childPlanIds.length === 0;
}

function assertValidParallelWork(plan, proposedStep) {
  const foregroundSteps = plan.steps.filter((step) =>
    isMainAgentForegroundStep(step.id === proposedStep.id ? proposedStep : step)
  );
  if (foregroundSteps.length > 1) {
    throw new Error(
      "Only one main-agent step may be in progress. Use agents, linked subplans, or parallel_activity for genuine concurrent work.",
    );
  }
}

function snapshot(plan) {
  let rootPlan = plan;
  while (rootPlan.parentPlanId) rootPlan = requirePlan(rootPlan.parentPlanId);
  if (rootPlan.goalLink) {
    rootPlan.goalLink = syncGoalLink(rootPlan.goalLink, readGoal(rootPlan.goalLink.threadId));
  }
  const finished = plan.steps.filter((step) =>
    step.status === "completed" || step.status === "skipped"
  ).length;
  return {
    id: plan.id,
    goal: rootPlan.goalLink ? {
      state: rootPlan.goalLink.state,
      availability: rootPlan.goalLink.availability,
      status: rootPlan.goalLink.status,
    } : null,
    title: plan.title,
    status: plan.status,
    revision: plan.revision,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    completedAt: plan.completedAt,
    progress: planProgress(plan),
    parent: plan.parentPlanId
      ? { plan_id: plan.parentPlanId, step_id: plan.parentStepId }
      : null,
    finished,
    total: plan.steps.length,
    steps: plan.steps.map((step) => {
      const { childPlanIds, ...publicStep } = step;
      return {
        ...publicStep,
        childPlans: childPlanIds
          .map((planId) => plans.get(planId))
          .filter(Boolean)
          .map((child) => ({
            id: child.id,
            title: child.title,
            status: child.status,
            progress: planProgress(child),
          })),
      };
    }),
  };
}

function resultFor(plan, text, extra = {}, stepId = null, compact = false) {
  const publicPlan = snapshot(plan);
  const needsGoal = !plan.parentPlanId && plan.status === "active"
    && (!publicPlan.goal || publicPlan.goal.state === "waiting");
  const goalNotice = JSON.stringify(publicPlan.goal ?? { state: "unbound" });
  const nextAction = needsGoal && plan.lastGoalNotice !== goalNotice
    ? `Check get_goal; create a matching goal only when authorized and no unfinished goal exists. Objective: ${JSON.stringify(plan.originalTitle ?? plan.title)}. Otherwise report the limitation once. Never replace or recreate a user-cleared goal.`
    : null;
  plan.lastGoalNotice = goalNotice;
  const payload = compact ? {
    plan_id: plan.id, revision: plan.revision, status: plan.status,
    finished: publicPlan.finished, total: publicPlan.total, progress: publicPlan.progress,
    ...(stepId ? { step: publicPlan.steps.find(step => step.id === stepId) } : {}),
  } : { plan: publicPlan };
  return {
    structuredContent: { ...payload, next_action: nextAction, ...extra },
    content: [{ type: "text", text }],
  };
}

function requirePlan(planId) {
  const plan = plans.get(planId);
  if (!plan) throw new Error(`Task plan not found: ${planId}`);
  return plan;
}

function touch(plan) {
  plan.revision += 1;
  plan.updatedAt = new Date().toISOString();
  const allFinished = plan.steps.every((step) =>
    step.status === "completed" || step.status === "skipped"
  );
  if (allFinished && plan.status === "active") {
    plan.status = "completed";
    plan.completedAt = plan.updatedAt;
  }
}

function syncLinkedStep(parent, step, visited = new Set()) {
  if (visited.has(parent.id)) throw new Error("Task plan hierarchy contains a cycle");
  visited.add(parent.id);
  const children = step.childPlanIds.map((planId) => requirePlan(planId));
  if (!children.length) return;

  step.progress = children.some((child) => planProgress(child) === null) ? null : Math.round(
    children.reduce((total, child) => total + planProgress(child), 0) / children.length,
  );
  const allCompleted = children.every((child) => child.status === "completed");
  const allTerminal = children.every((child) =>
    child.status === "completed" || child.status === "cancelled"
  );
  if (allCompleted) {
    step.status = "completed";
    step.progress = 100;
    step.agents = step.agents.map(agent => ({ ...agent, status: "completed" }));
  } else if (allTerminal) {
    step.status = "blocked";
    step.agents = [];
  } else {
    step.status = "in_progress";
  }
  touch(parent);

  if (parent.parentPlanId) {
    const grandparent = requirePlan(parent.parentPlanId);
    const parentStep = grandparent.steps.find((item) => item.id === parent.parentStepId);
    if (!parentStep) throw new Error(`Parent task plan step not found: ${parent.parentStepId}`);
    syncLinkedStep(grandparent, parentStep, visited);
  }
}

function propagatePlanProgress(plan) {
  if (!plan.parentPlanId) return;
  const parent = requirePlan(plan.parentPlanId);
  const step = parent.steps.find((item) => item.id === plan.parentStepId);
  if (!step) throw new Error(`Parent task plan step not found: ${plan.parentStepId}`);
  syncLinkedStep(parent, step);
}

const server = new McpServer(
  { name: "codex-task-plan", version: "0.1.0" },
  {
    instructions: "Only the main agent manages this plugin. Delegated subagents must not call any task-plan tools; they report results to the main agent. Keep completed agent icons with status=completed; only working agents count as parallel work. " +
      "Create one plan only for substantial decomposed work. Build ordinary main-agent steps as a real sequential execution path. Keep its returned plan_id with the task context and accept a known plan_id from another conversation when explicitly requested. Revise the existing plan when scope changes instead of replacing it. Only one ordinary main-agent step may be in progress; additional concurrent steps require assigned agents, linked subplans, or a concise parallel_activity describing real background work. Attach the names of currently working subagents to their steps. Render once after creation. Before each later user-visible progress response, record its visual weight as 1, 2, or 3 points. Render another copy only when that tool returns should_show=true; this requires both 4 accumulated points and plan progress changed since the previous render.",
  },
);

registerAppTool(
  server,
  "create_task_plan",
  {
    title: "Create task plan",
    description:
      "Create a titled plan for substantial work with multiple meaningful steps. To make it a subplan, provide both parent_plan_id and parent_step_id; its aggregate progress then drives that parent step automatically. Returns a unique plan_id for later updates and rendering.",
    inputSchema: {
      title: z.string().min(1).max(120),
      steps: z.array(z.string().min(1).max(180)).min(2).max(12),
      parent_plan_id: z.string().uuid().optional(),
      parent_step_id: z.string().min(1).optional(),
      thread_id: z.string().uuid().optional().describe("For a root plan, pass the actual current Codex thread ID to observe its matching native goal. Never guess an ID. Subplans inherit the root binding."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Creating task plan…",
      "openai/toolInvocation/invoked": "Task plan created",
    },
  },
  async ({ title, steps, parent_plan_id: parentPlanId, parent_step_id: parentStepId, thread_id: threadId }) => {
    if ((parentPlanId && !parentStepId) || (!parentPlanId && parentStepId)) {
      throw new Error("parent_plan_id and parent_step_id must be provided together");
    }
    let parent = null;
    let parentStep = null;
    if (parentPlanId) {
      parent = requirePlan(parentPlanId);
      if (parent.status !== "active") throw new Error("Cannot attach a subplan to an inactive plan");
      parentStep = parent.steps.find((item) => item.id === parentStepId);
      if (!parentStep) throw new Error(`Parent task plan step not found: ${parentStepId}`);
      if (parentStep.status === "completed" || parentStep.status === "skipped") {
        throw new Error("Cannot attach a subplan to a finished step");
      }
    }
    const now = new Date().toISOString();
    const plan = {
      id: randomUUID(),
      title,
      originalTitle: title,
      status: "active",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      reanchorScore: 0,
      lastShownRevision: null,
      parentPlanId: parentPlanId ?? null,
      parentStepId: parentStepId ?? null,
      goalLink: !parentPlanId && threadId ? {
        threadId, expectedObjective: title, goalId: null,
        state: "waiting", status: null, availability: "available",
      } : null,
      nextStepNumber: steps.length + 1,
      steps: steps.map((stepTitle, index) => ({
        id: `step-${index + 1}`,
        title: stepTitle,
        status: "pending",
        progress: null,
        note: "",
        agents: [],
        parallelActivity: "",
        childPlanIds: [],
      })),
    };
    plans.set(plan.id, plan);
    if (parent && parentStep) {
      parentStep.childPlanIds.push(plan.id);
      syncLinkedStep(parent, parentStep);
    }
    return resultFor(plan, `Created task plan ${plan.id}.`, { plan_id: plan.id });
  },
);

registerAppTool(
  server,
  "revise_task_plan",
  {
    title: "Revise task plan",
    description:
      "Revise an active plan when scope changes without losing state on retained steps. Optionally rename the plan or steps, append new pending steps, remove only pending or skipped leaf steps, and provide the complete remaining step order. Completed plans are read-only: create a new plan for new work. Linked parent progress is recalculated automatically.",
    inputSchema: {
      plan_id: z.string().uuid(),
      title: z.string().min(1).max(120).optional(),
      rename_steps: z.array(renamedStepSchema).max(12).optional(),
      add_steps: z.array(z.string().min(1).max(180)).max(10).optional(),
      remove_step_ids: z.array(z.string().min(1)).max(10).optional(),
      order: z.array(z.string().min(1)).min(2).max(12).optional(),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Revising task plan…",
      "openai/toolInvocation/invoked": "Task plan revised",
    },
  },
  async ({
    plan_id: planId,
    title,
    rename_steps: renameSteps = [],
    add_steps: addSteps = [],
    remove_step_ids: removeStepIds = [],
    order,
  }) => {
    const plan = requirePlan(planId);
    if (plan.status === "cancelled") throw new Error("Cannot revise a cancelled task plan");
    if (title === undefined && !renameSteps.length && !addSteps.length && !removeStepIds.length && !order) {
      throw new Error("No task plan changes were provided");
    }

    const stepById = new Map(plan.steps.map((step) => [step.id, step]));
    const renamedIds = new Set();
    for (const item of renameSteps) {
      if (!stepById.has(item.step_id)) throw new Error(`Task plan step not found: ${item.step_id}`);
      if (renamedIds.has(item.step_id)) throw new Error(`Duplicate renamed step: ${item.step_id}`);
      renamedIds.add(item.step_id);
    }

    const removedIds = new Set(removeStepIds);
    if (removedIds.size !== removeStepIds.length) throw new Error("Duplicate removed step ID");
    for (const stepId of removedIds) {
      const step = stepById.get(stepId);
      if (!step) throw new Error(`Task plan step not found: ${stepId}`);
      if (step.status !== "pending" && step.status !== "skipped") {
        throw new Error(`Only pending or skipped steps may be removed: ${stepId}`);
      }
      if (step.childPlanIds.length) throw new Error(`Cannot remove a step with linked subplans: ${stepId}`);
    }

    const retainedSteps = plan.steps.filter((step) => !removedIds.has(step.id));
    const finalCount = retainedSteps.length + addSteps.length;
    if (finalCount < 2 || finalCount > 12) {
      throw new Error("A revised task plan must contain 2-12 steps");
    }

    if (order) {
      const expectedIds = new Set(retainedSteps.map((step) => step.id));
      const orderedIds = new Set(order);
      if (orderedIds.size !== order.length || order.length !== expectedIds.size) {
        throw new Error("Order must contain every retained step ID exactly once");
      }
      for (const stepId of order) {
        if (!expectedIds.has(stepId)) throw new Error(`Order contains an unknown or removed step: ${stepId}`);
      }
    }

    if (title !== undefined) plan.title = title;
    for (const item of renameSteps) stepById.get(item.step_id).title = item.title;
    plan.steps = order ? order.map((stepId) => stepById.get(stepId)) : retainedSteps;
    const addedSteps = addSteps.map((stepTitle) => {
      const step = {
        id: `step-${plan.nextStepNumber++}`,
        title: stepTitle,
        status: "pending",
        progress: null,
        note: "",
        agents: [],
        parallelActivity: "",
        childPlanIds: [],
      };
      plan.steps.push(step);
      return { id: step.id, title: step.title };
    });
    touch(plan);
    propagatePlanProgress(plan);
    return resultFor(plan, `Revised task plan ${plan.id}.`, { added_steps: addedSteps }, null, true);
  },
);

registerAppTool(
  server,
  "record_task_plan_output",
  {
    title: "Score task plan distance",
    description:
      "Record the visual weight of exactly one upcoming user-visible progress response: 1 point for short, 2 for medium, or 3 for long. Call once immediately before that response. Returns should_show=true only after at least 4 accumulated points and when the plan changed since its previous render.",
    inputSchema: {
      plan_id: z.string().uuid(),
      points: z.number().int().min(1).max(3),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    _meta: {
      ui: { visibility: ["model"] },
      "openai/visibility": "private",
      "openai/toolInvocation/invoking": "Scoring plan distance…",
      "openai/toolInvocation/invoked": "Plan distance scored",
    },
  },
  async ({ plan_id: planId, points }) => {
    const plan = requirePlan(planId);
    plan.reanchorScore = Math.min(reanchorThreshold, plan.reanchorScore + points);
    const progressChanged =
      plan.lastShownRevision === null || plan.revision > plan.lastShownRevision;
    const shouldShow = plan.reanchorScore >= reanchorThreshold && progressChanged;
    return {
      structuredContent: {
        plan_id: plan.id,
        points,
        score: plan.reanchorScore,
        threshold: reanchorThreshold,
        progress_changed: progressChanged,
        should_show: shouldShow,
      },
      content: [
        {
          type: "text",
          text: shouldShow
            ? "Re-anchor the task plan before this response."
            : "Keep the existing task plan anchor.",
        },
      ],
    };
  },
);

registerAppTool(
  server,
  "update_task_plan_step",
  {
    title: "Update task plan step",
    description:
      "Update one step in the current conversation's plan. Use waiting_for_user only when progress requires a direct user answer, and put the concise question in note. Only one ordinary main-agent step may be in progress. Additional concurrent steps require assigned agents, linked subplans, or parallel_activity describing a real background operation. Use progress only for in-progress work and agents for subagents currently working on this step. A step with linked subplans derives status and progress from them; manual status or progress is ignored while notes and agents remain editable. Completing the final unfinished step completes the plan automatically.",
    inputSchema: {
      plan_id: z.string().uuid(),
      step_id: z.string().min(1),
      status: z.enum(statuses),
      progress: z.number().int().min(0).max(100).nullable().optional().describe("Measured percentage only. null means unknown and shows an indeterminate activity bar. Omit to preserve it during the same step; update note at meaningful checkpoints, never invent percentages."),
      note: z.string().max(240).optional(),
      agents: z.array(agentSchema).max(8).optional(),
      parallel_activity: z.string().min(1).max(160).optional(),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Updating task plan…",
      "openai/toolInvocation/invoked": "Task plan updated",
    },
  },
  async ({
    plan_id: planId,
    step_id: stepId,
    status,
    progress,
    note,
    agents,
    parallel_activity: parallelActivity,
  }) => {
    const plan = requirePlan(planId);
    const step = plan.steps.find((item) => item.id === stepId);
    if (!step) throw new Error(`Task plan step not found: ${stepId}`);
    if (step.childPlanIds.length) {
      if (parallelActivity !== undefined) {
        throw new Error("parallel_activity is unnecessary for a step driven by linked subplans");
      }
      if (note !== undefined) step.note = note;
      if (agents !== undefined) step.agents = agents;
      syncLinkedStep(plan, step);
      return resultFor(plan, `Recalculated ${stepId} from linked subplans.`, {}, stepId, true);
    }
    if (parallelActivity !== undefined && status !== "in_progress") {
      throw new Error("parallel_activity may be used only while a step is in progress");
    }

    const proposedStep = {
      ...step,
      status,
      agents: status === "in_progress" ? (agents ?? step.agents)
        : ["completed", "skipped"].includes(status)
          ? (agents ?? step.agents).map(agent => ({ ...agent, status: "completed" })) : [],
      parallelActivity: status === "in_progress"
        ? (parallelActivity ?? step.parallelActivity)
        : "",
    };
    assertValidParallelWork(plan, proposedStep);

    const previousStatus = step.status;
    step.status = proposedStep.status;
    step.agents = proposedStep.agents;
    step.parallelActivity = proposedStep.parallelActivity;
    if (status === "completed") step.progress = 100;
    else if (status === "pending") step.progress = null;
    else if (progress !== undefined) step.progress = progress;
    else if (status === "in_progress" && ["pending", "completed", "skipped"].includes(previousStatus)) step.progress = null;
    if (note !== undefined) step.note = note;
    else if (parallelActivity !== undefined) step.note = parallelActivity;
    touch(plan);
    propagatePlanProgress(plan);
    return resultFor(plan, `Updated ${stepId} to ${status}.`, {}, stepId, true);
  },
);

registerAppTool(
  server,
  "get_task_plan",
  {
    title: "Read task plan",
    description: "Read the latest state of a task plan by its known plan_id.",
    inputSchema: {
      plan_id: z.string().uuid(),
      thread_id: z.string().uuid().optional().describe("Actual current thread ID, only to establish a missing root goal binding. Never guess or change an existing binding."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    _meta: {
      ui: { visibility: ["model", "app"] },
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Reading task plan…",
      "openai/toolInvocation/invoked": "Task plan read",
    },
  },
  async ({ plan_id: planId, thread_id: threadId }) => {
    const plan = requirePlan(planId);
    if (threadId && !plan.parentPlanId && !plan.goalLink) {
      plan.goalLink = { threadId, expectedObjective: plan.originalTitle ?? plan.title, goalId: null,
        state: "waiting", status: null, availability: "available" };
    }
    return resultFor(plan, `Task plan ${plan.id} is ${plan.status}.`);
  },
);

registerAppTool(
  server,
  "show_task_plan",
  {
    title: "Show task plan",
    description:
      "Render the current always-open plan inline. Call after creation, when record_task_plan_output returns should_show=true, or when the user explicitly asks for another copy. Do not call it for any other normal update. The view field is retained for compatibility.",
    inputSchema: {
      plan_id: z.string().uuid(),
      view: z.enum(["full", "chip"]).default("chip"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    _meta: companionMode ? {} : {
      ui: { resourceUri: widgetUri, visibility: ["model", "app"] },
      "openai/outputTemplate": widgetUri,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Opening task plan…",
      "openai/toolInvocation/invoked": "Task plan ready",
    },
  },
  async ({ plan_id: planId, view }) => {
    const plan = requirePlan(planId);
    plan.lastShownRevision = plan.revision;
    plan.reanchorScore = 0;
    return resultFor(plan, companionMode ? `Queued task plan ${plan.id} for the companion. Delivery is asynchronous; selection is unchanged.` : `Rendered task plan ${plan.id}.`, {
      view,
      reanchor_score: plan.reanchorScore,
      shown_revision: plan.lastShownRevision,
    });
  },
);

registerAppTool(
  server,
  "set_companion_focus_mode",
  {
    title: "Set companion focus mode",
    description:
      "Enable or disable the persisted Task Plan companion behavior that collapses the plan window to a draggable icon while Codex is unfocused. Use only when the user explicitly asks to change this preference.",
    inputSchema: { enabled: z.boolean() },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    _meta: {
      ui: { visibility: ["model"] },
      "openai/visibility": "private",
      "openai/toolInvocation/invoking": "Updating companion behavior…",
      "openai/toolInvocation/invoked": "Companion behavior updated",
    },
  },
  async ({ enabled }) => {
    if (!companionSocket) throw new Error("Task Plan companion is not configured for this plugin process.");
    const response = await sendCompanion(companionSocket, { action: "set_focus_collapse", enabled });
    return {
      structuredContent: { enabled, state: response.state },
      content: [{ type: "text", text: `Task Plan focus-collapse mode ${enabled ? "enabled" : "disabled"}.` }],
    };
  },
);

registerAppTool(
  server,
  "cancel_task_plan",
  {
    title: "Cancel task plan",
    description: "Mark a task plan as cancelled when the work is abandoned rather than completed.",
    inputSchema: { plan_id: z.string().uuid() },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Cancelling task plan…",
      "openai/toolInvocation/invoked": "Task plan cancelled",
    },
  },
  async ({ plan_id: planId }) => {
    const plan = requirePlan(planId);
    plan.status = "cancelled";
    plan.completedAt = new Date().toISOString();
    touch(plan);
    propagatePlanProgress(plan);
    return resultFor(plan, `Cancelled task plan ${plan.id}.`, {}, null, true);
  },
);

registerAppResource(
  server,
  "Codex Task Plan",
  widgetUri,
  { description: "Compact always-open inline task plan with parallel work and subagent indicators." },
  async () => ({
    contents: [
      {
        uri: widgetUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: widgetHtml,
        // Codex defaults to a 200px frame floor; let the widget report its content height.
        _meta: { "openai/widgetMinFrameHeight": 0 },
      },
    ],
  }),
);

if (process.env.TASK_PLAN_NATIVE_EVENT_PROBE === '1') {
  const { registerNativeEventProbe } = await import('./native-event-probe.mjs');
  await registerNativeEventProbe(server);
}
await server.connect(new StdioServerTransport());
