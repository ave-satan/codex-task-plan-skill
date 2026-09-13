# Storage and compact replies

Plans created by this version persist in `CODEX_HOME/task-plan/plans.sqlite`
(default `~/.codex/task-plan/plans.sqlite`), outside the plugin cache. `TASK_PLAN_DB`
can override the database path; tests use an isolated temporary database or `:memory:`.
No earlier chat history is imported automatically. Plans already lost by an older
in-memory server cannot be recovered by this change.

Each tool operation reloads current state inside a SQLite transaction, commits
changes before acknowledging success, and rolls back failures. Multiple server
processes share the same store. Plan revisions, hierarchy, goal identity, output
score and last displayed revision survive restarts. Goal storage remains read-only.
An unreadable/corrupt database is an error, not permission to reset stored plans.

Create, get and show return full snapshots for context recovery and widget rendering.
Update returns a compact plan summary and the changed step; revise returns a summary
and newly allocated step IDs; cancel returns a summary. Use get when the complete
state is needed. The widget still reads full snapshots through its existing API.
Goal setup guidance is returned in next_action only when the relevant goal state
changes, not duplicated in content or repeated after every update.

Validation: run `scripts/restart-smoke.mjs` with the configured Node runtime.
It exercises abrupt restart, concurrent processes, linked subplans, output scoring,
goal identity, cancellation and compact response size through real MCP clients.
