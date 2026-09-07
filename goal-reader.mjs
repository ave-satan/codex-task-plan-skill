import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

// Local Codex compatibility adapter. Never creates or writes the host database.
export function readGoal(threadId, databasePath = join(process.env.CODEX_SQLITE_HOME || process.env.CODEX_HOME || join(homedir(), ".codex"), "goals_1.sqlite")) {
  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    return {
      available: true,
      goal: db.prepare("SELECT goal_id AS id, objective, status FROM thread_goals WHERE thread_id = ?").get(threadId) ?? null,
    };
  } catch {
    return { available: false, goal: null };
  } finally {
    db?.close();
  }
}

export function syncGoalLink(link, observation) {
  if (!link || link.state === "detached") return link;
  if (!observation.available) return { ...link, availability: "unavailable" };
  const goal = observation.goal;
  if (link.goalId) {
    if (!goal || goal.id !== link.goalId) {
      return { ...link, state: "detached", status: null, availability: "available" };
    }
  } else if (!goal || goal.objective !== link.expectedObjective) {
    return { ...link, availability: "available", state: "waiting", status: null };
  }
  if (!["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"].includes(goal.status)) {
    return { ...link, availability: "unavailable" };
  }
  return { ...link, state: "linked", availability: "available", goalId: goal.id, status: goal.status };
}
