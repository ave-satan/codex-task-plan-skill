---
name: manage
description: Create and maintain a compact inline plan plus a matching static Codex goal when a substantial multi-step task would benefit from visible tracking. Do not create plans for short questions or simple one-step edits.
---

# Manage

Only the main agent uses this plugin. If you are a delegated subagent, do not call any task-plan tools: do not create, read, update, score, show or cancel plans, and do not create a native goal for your assignment. Report progress and results to the main agent instead. The main agent uses one root plan per substantial task only when the work is meaningfully decomposable.

1. Call `create_task_plan` with a short title and 2-12 outcome-oriented steps. Build ordinary main-agent steps as the real sequential execution path: each should represent a distinct stage or checkpoint, not overlapping buckets of files that the same agent will edit together. Add parallel sibling steps only when they are independent enough for subagents, linked subplans, or an actual background operation. For a root plan, omit `parent_plan_id` and `parent_step_id`.
2. Keep the returned `plan_id` with the task context. A known plan ID may be opened from another conversation when the user provides or requests it; never guess an ID.
3. When the `create_goal` host tool is available and there is no unfinished goal, create one static goal immediately after creating the root plan. This behavior is explicitly requested by the plugin owner and does not require another confirmation. Do not create a separate native goal for a subplan. Do not set a token budget unless the user explicitly supplied one.
4. Set the goal objective to the plan title exactly, with no icon, step count, checklist, completion clause, or progress text. The inline plan already carries those details, and keeping them out of the native goal prevents its compact bar from becoming noisy. Never change the goal objective later.

   ```text
   <plan title>
   ```

5. If an unfinished goal already exists, do not replace it or reset its accounting. Keep that goal and create only the task plan.
6. Immediately call `show_task_plan` with `view: "full"` exactly once.

   After preparing the plan and before executing its steps, assess which parts can run in parallel without violating dependencies or the required sequence. Delegate ready, bounded, independent work to subagents when its volume and expected time savings justify the cost of startup, coordination, and integration. Give each subagent a clear deliverable, required inputs, and non-overlapping write ownership; keep useful independent work for the main agent. Do not start work whose prerequisites are unfinished, duplicate the same assignment, or delegate tiny tasks merely to create parallelism. Reflect real concurrent branches in the plan and record their assigned agents. The main agent integrates and checks their results before dependent steps begin. If no worthwhile parallel work exists, proceed sequentially. Reassess when the active plan changes or dependencies become ready; use only available and permitted subagent tools, within the user's scope.

7. Before starting a step, mark it `in_progress`. Keep exactly one ordinary main-agent step active. Additional steps may be `in_progress` only when each extra branch has assigned `agents`, linked subplans, or a concise `parallel_activity` naming an actual concurrent background operation. Related edits performed sequentially by the same agent do not qualify as parallel work: keep one step active, then advance or revise the plan. Supply an honest numeric `progress` only when measurable.
8. The main agent records actual assignments in `agents`, for example `{ "name": "reviewer", "category": "review", "status": "working" }`. Choose the category from the delegated task using the table below. When a subagent finishes, promptly set its assignment to `completed`, retaining its icon as history; only `working` assignments animate and count as concurrent work. Replace the complete list when assignments change. Reassigning a finished agent requires explicitly setting `working` again. Omitted status means working for legacy entries. If no worker remains, do not leave multiple ordinary foreground steps active: complete the finished step or reflect an actual blocker. For genuine non-agent concurrency, pass `parallel_activity` describing the real background operation.
9. In delegation prompts, tell subagents not to use this plugin and to return their progress/results to the main agent. Do not ask them to create subplans. Existing linked subplans remain supported for compatibility and are maintained only by the main agent; their progress still propagates to the parent automatically.
10. When scope or sequencing changes while the plan is active, call `revise_task_plan` on that plan instead of creating a replacement. It may rename the plan or retained steps, append pending steps, remove only pending or skipped leaf steps, and reorder retained steps by supplying all their IDs. Preserve completed work as history; never remove a completed or active step. Never reuse, reopen, rename, append work to, or change steps of a completed plan, including its linked subplans. Completed plans are historical records and may only be viewed; new work requires a new plan with a new ID, even in the same conversation or on the same topic. Revising an active subplan automatically changes its parent-step progress. Keep the native goal objective unchanged even if the active plan title changes.
11. Update ordinary steps as observable work changes. Use `waiting_for_user` only when further progress genuinely requires a direct answer or decision from the user; put the concise question in the step note, then return the step to `in_progress` when the answer arrives. Do not use it while safe useful work can continue. Use `blocked` for a non-user obstacle or failure and include a concise note. Never recreate or update the goal merely to mirror step progress.
12. Before every later user-visible progress response, call `record_task_plan_output` exactly once for that upcoming response. Assign points only from its expected visible size: `1` for up to about 300 characters, `2` for about 301-900 characters, and `3` for more than 900 characters or visually bulky output. Do not score the initial response beside the initial card, internal tool calls, elapsed time, response count, or state-transition count.
13. Call `show_task_plan` once immediately before the response only when `record_task_plan_output` returns `should_show: true`. This happens only when the accumulated score reaches 4 and plan progress has changed since the previous card. Plan revisions and changes propagated from linked subplans count as plan progress changes. If the score reaches 4 without a progress change, do not render; the score stays ready until a later plan change. Never render more than one copy per response. The mounted card continues polling between re-anchors. Render outside this gate only when the user explicitly asks for another copy or reports that the original card is unavailable. Do not emit an unsupported Markdown link to an older card.
14. Mark completed work promptly. Completing or skipping every step completes the plan automatically; the existing inline card remains in the conversation with its final state. Completion does not require another card. Apply the same output scoring and `should_show` gate to the final response; do not force a final render or add extra points merely because work finished.
15. Only after the requested outcome is genuinely achieved, all required work is finished, and the root plan is complete, call `update_goal` with `status: "complete"`. Do not mark the goal complete just because one subplan or its checklist is exhausted.
16. If work on any plan is abandoned, call `cancel_task_plan`. Do not falsely complete the goal.

Do not create a plan merely to answer a question, inspect one file, or perform a trivial edit. Keep step titles compact and do not expose internal reasoning.

## Agent work categories

Use one category for the current assignment, not for the agent's name or permanent persona. Choose its primary deliverable; reclassify only when its actual assignment changes, not on every progress update. Multiple agents on a step may have different categories. Never add fictional agents to display icons. For legacy assignments whose task is unknown, omit `category` and keep the neutral icon.

| Category | Primary work |
| --- | --- |
| `research` | Gather facts and sources, investigate options |
| `architecture` | Design architecture, contracts and component boundaries |
| `design` | Visual design, layout, typography and UX |
| `implementation` | Implement or change application behavior |
| `diagnostics` | Reproduce a failure and identify its cause |
| `testing` | Write/run tests or verify acceptance requirements |
| `review` | Independently critique existing code or decisions |
| `data` | Transform, analyze, import or reconcile datasets |
| `documentation` | Write documentation, guides or explanatory text |
| `operations` | Configure, deploy and maintain services/infrastructure |

Prefer `diagnostics` for finding why something fails, `testing` for checking whether it meets requirements, and `review` for independent critique. Running tests as one part of an implementation does not change `implementation` into `testing`; likewise, a design document can remain `architecture` when its output is architectural decisions.

Do not classify every Council specialist as `review` merely because the workflow calls its outputs reviews or the agent name contains `_review`. Classify the current deliverable: gathering documented facts is `research`; designing alternatives, contracts, or making an architectural arbitration decision is `architecture`; independently critiquing an existing proposal is `review`. A security or data specialist can legitimately be `review` when reviewing a proposal; domain expertise alone does not determine the icon. When an agent moves from critique to creating a design, update its category for that assignment. Do not force category diversity when the assignments genuinely are all reviews.

## Native goal integration

After creating a root plan, follow its `next_action`: check the host goal, create the matching goal when authorized and no unfinished goal exists, then call `get_task_plan` to confirm `goal.state` is `linked` before starting work. If you omitted the thread ID at creation, supply the actual current `thread_id` to `get_task_plan`; do not recreate the plan. If a conflicting goal, missing authorization, unavailable host tool, or storage problem prevents this, report the specific limitation once rather than silently skipping goal setup. Never replace an unfinished goal to satisfy this check.

## Honest step progress

For a newly started step, omit `progress` when no defensible percentage exists. Unknown progress is `null` and displays an indeterminate activity bar, not zero percent. Use numeric percentages only for measured completion; use `progress: null` to explicitly clear a percentage that is no longer meaningful. During the same step, omitting the field preserves its value. Update the step's concise `note` at substantive checkpoints (a result produced, verification started, or a concrete blocker found), even if the percentage is unknown. Short steps may move straight to completion. Do not invent intermediate percentages or generate updates merely to animate the UI.

## Goal observation details

For a root plan, supply the actual current `thread_id` to `create_task_plan`. In a local task, obtain it from the host context or `printenv CODEX_THREAD_ID`; never guess it or take the ID of a neighboring task. If the ID is unavailable, omit it and use the plan without native goal observation. Subplans inherit their root plan's binding.

The local read-only adapter observes the goal database during card refreshes. It initially binds only to a goal whose objective exactly matches the original plan title, then remembers that goal's ID. A changed objective on the same goal keeps the binding. A cleared or replaced goal detaches the old plan. Do not automatically recreate a user-cleared goal or resume a user-paused goal. Native goal controls remain under user control.

Pause, blocking, and usage/budget limits are displayed as a separate execution status. Do not reset step statuses, percentages, notes, assignments, or output score because of a pause or resume. On continuation, read the existing plan and verify actual work before updating it. Background operations may still finish during a goal pause; record their real result. A completed native goal never automatically completes unfinished plan steps. If the goal is complete but steps remain, reconcile the discrepancy against actual results.

This adapter depends on the local Codex `goals_1.sqlite` format and opens it read-only. It uses `CODEX_SQLITE_HOME` when provided, otherwise `CODEX_HOME` (default `~/.codex`). If the host uses a custom `sqlite_home` setting, pass that directory as `CODEX_SQLITE_HOME` to the plugin process. Missing or incompatible storage is shown as an unavailable connection, never interpreted as cancellation. Card goal changes update the mounted widget without counting as plan progress for re-anchoring.
