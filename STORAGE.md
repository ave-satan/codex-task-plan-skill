# Storage and compact replies

Plans created by this version persist in `CODEX_HOME/task-plan/plans.sqlite`
(default `~/.codex/task-plan/plans.sqlite`), outside the plugin cache. `TASK_PLAN_DB`
can override the database path; tests use an isolated temporary database or `:memory:`.
No earlier chat history is imported automatically. Plans already lost by an older
in-memory server cannot be recovered by this change.

Each tool operation reloads current state inside a SQLite transaction, commits
changes before acknowledging success, and rolls back failures. Multiple server
processes share the same store. Plan revisions, hierarchy, goal identity and terminal state survive restarts. Goal storage remains read-only.
An unreadable/corrupt database is an error, not permission to reset stored plans.

Root plans store a chat ID independently of their goal link. Older roots whose
chat ID exists only in `goalLink.threadId` remain readable. The conversation panel
uses only the chat ID injected by Codex into MCP request metadata, selects that
chat's newest root, and never falls back to global plans. A completed root remains
visible for 30 seconds. The final card renders from its conversation tool result.
After it acknowledges rendering and the 30-second window expires, the root and its
descendants are removed. A missing acknowledgement allows retries for one day.
Cancelled roots and completed roots without a chat binding expire after 30 seconds.
Older active roots do not reappear when a newer root finishes or is cancelled.

The panel reads through MCP once per second while visible. A persistent store
generation and monotonic revision order snapshots across server processes.
Each chat's rendering confirmations are stored separately in `panel_receipts`.
These confirmations do not mutate plans or their revisions.

The existing visible-panel reads also refresh a short-lived presence lease in
`panel_presence`. `ensure_task_plan_panel` atomically reuses an inline card or an
in-progress opening. It never returns UI metadata. When a panel is missing it
returns a one-use token for `open_task_plan_panel`, which renders inline by
default; this keeps reuse responses
separate from the client's rendering session cache. A separate app-only menu
renderer keeps the native **План этого чата** entrypoint. Duplicate mounted
instances request closure of their own tab. Teardown releases presence; a
separate leases for the inline card and tab, each with a 15-second expiry, cover interrupted cleanup without treating old render
receipts as proof that a panel is still open.

When a fresh valid read confirms that a previously displayed plan has expired, been replaced,
or been cancelled, the panel requests closure of its own tab. An initially empty
panel, identity errors, and transient connection failures do not close the tab.

Create and get return full snapshots for context recovery.
Update returns a compact plan summary and the changed step; revise returns a summary
and newly allocated step IDs; cancel returns a summary. Use get when the complete
state is needed. `open_task_plan_panel` and the app-only `get_chat_task_plan` return
the current chat's panel snapshot. A separate tab opens on user action.
Normal updates are reflected in place.
Goal setup guidance is returned in next_action only when the relevant goal state
changes, not duplicated in content or repeated after every update.

Validation: run `scripts/restart-smoke.mjs` with the configured Node runtime.
It exercises abrupt restart, concurrent processes, linked subplans,
goal identity, cancellation and compact response size through real MCP clients.
Run `scripts/panel-smoke.mjs` for chat identity, cross-chat isolation, linked plans,
external updates, terminal-state retention, and legacy ownership migration.
