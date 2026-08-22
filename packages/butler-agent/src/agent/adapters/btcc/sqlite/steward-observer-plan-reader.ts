import type { Database } from "bun:sqlite";
import type { StewardObserverPlan } from "../../../../gateways/app/domain/sessions/steward-observer.ts";

export function readStewardObserverPlan(
  db: Database,
  sessionId: string,
): StewardObserverPlan | null {
  const plan = db.query<{
    plan_revision_id: string;
    revision: number;
    actions_json: string;
    current_plan_revision_id: string;
  }, [string]>(`
    SELECT plan.plan_revision_id, plan.revision, plan.actions_json,
      work.current_plan_revision_id
    FROM btcc_guided_works work
    JOIN btcc_guided_work_plan_revisions plan
      ON plan.plan_revision_id = work.current_plan_revision_id
    WHERE work.session_id = ?
    ORDER BY work.updated_at DESC, work.work_id ASC
    LIMIT 1
  `).get(sessionId);
  if (!plan) return null;
  const actions = parsePlanActions(plan.actions_json);
  if (actions.length === 0) return null;
  const checkpoint = db.query<{
    plan_revision_id: string;
    action_states_json: string;
  }, [string, string]>(`
    SELECT plan_revision_id, action_states_json
    FROM btcc_guided_work_checkpoint_revisions
    WHERE work_id = (
      SELECT work_id FROM btcc_guided_works
      WHERE session_id = ? AND current_plan_revision_id = ?
      ORDER BY updated_at DESC, work_id ASC LIMIT 1
    )
    ORDER BY revision DESC
    LIMIT 1
  `).get(sessionId, plan.current_plan_revision_id);
  const actionProgress = checkpoint?.plan_revision_id === plan.plan_revision_id
    ? parseActionProgress(checkpoint.action_states_json)
    : [];
  const planReview = db.query<{
    verdict: string;
    bound_plan_revision_id: string | null;
  }, [string, string]>(`
    SELECT verdict, bound_plan_revision_id
    FROM btcc_guided_work_review_revisions
    WHERE work_id = (
      SELECT work_id FROM btcc_guided_works
      WHERE session_id = ? AND current_plan_revision_id = ?
      ORDER BY updated_at DESC, work_id ASC LIMIT 1
    ) AND subject = 'plan'
    ORDER BY revision DESC
    LIMIT 1
  `).get(sessionId, plan.current_plan_revision_id);
  return {
    plan_revision_id: plan.plan_revision_id,
    revision: plan.revision,
    actions,
    // The plan is durable only when the current Plan review binds this exact
    // revision. Action status is likewise reported only from a checkpoint
    // bound to that revision; work status never fabricates per-action proof.
    action_progress: actionProgress,
    approved: planReview?.verdict === "accept" &&
      planReview?.bound_plan_revision_id === plan.plan_revision_id,
  };
}

function parsePlanActions(value: string): StewardObserverPlan["actions"] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((action) => {
      if (!isRecord(action) || typeof action.actionKey !== "string" ||
        typeof action.description !== "string") return [];
      return [{ action_key: action.actionKey, description: action.description }];
    });
  } catch {
    return [];
  }
}

function parseActionProgress(
  value: string,
): StewardObserverPlan["action_progress"] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((action) => {
      if (!isRecord(action) || typeof action.actionKey !== "string") return [];
      const status = action.status;
      if (status !== "pending" && status !== "active" && status !== "done" &&
        status !== "blocked" && status !== "skipped") return [];
      return [{ action_key: action.actionKey, status }];
    });
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
