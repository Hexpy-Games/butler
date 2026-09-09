import type { Database } from "bun:sqlite";
import type { StewardObserverPlan } from "../../../../gateways/app/domain/sessions/steward-observer.ts";
import { readProjectWorkPlan } from "../project-ledger/index.ts";

export function readStewardObserverPlan(
  db: Database,
  sessionId: string,
  butlerData?: string,
): StewardObserverPlan | null {
  const work = db.query<{
    work_id: string;
    scope_kind: "session" | "project";
    scope_ref: string;
    ledger_project_id: string | null;
    current_plan_revision_id: string | null;
  }, [string]>(`
    SELECT work.* FROM btcc_guided_turn_work_bindings binding
    JOIN btcc_guided_works work ON work.work_id = binding.work_id
      AND work.session_id = binding.session_id
    WHERE binding.turn_id = (
      SELECT turn_id FROM btcc_turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 1
    ) AND binding.is_current = 1
  `).get(sessionId);
  if (!work) return null;
  if (work.scope_kind === "project") {
    if (!butlerData || !work.ledger_project_id) return null;
    const view = readProjectWorkPlan({
      butlerData,
      appProjectId: work.scope_ref,
      ledgerProjectId: work.ledger_project_id,
      workId: work.work_id,
    });
    const plan = view?.currentPlan;
    if (!plan) return null;
    return {
      plan_revision_id: plan.planRevisionId,
      revision: plan.revision,
      actions: plan.actions.map((action) => ({
        action_key: action.actionKey, description: action.description,
      })),
      action_progress: view.actionProgress.map((action) => ({
        action_key: action.actionKey, status: action.status,
      })),
      approved: view.latestPlanReview?.verdict === "accept" &&
        view.latestPlanReview.boundPlanRevisionId === plan.planRevisionId,
    };
  }
  const plan = db.query<{
    plan_revision_id: string;
    revision: number;
    actions_json: string;
  }, [string, string | null]>(`
    SELECT plan_revision_id, revision, actions_json
    FROM btcc_guided_work_plan_revisions
    WHERE work_id = ? AND plan_revision_id = ?
  `).get(work.work_id, work.current_plan_revision_id);
  if (!plan) return null;
  const actions = parsePlanActions(plan.actions_json);
  if (actions.length === 0) return null;
  const checkpoint = db.query<{
    plan_revision_id: string;
    action_states_json: string;
  }, [string]>(`
    SELECT plan_revision_id, action_states_json
    FROM btcc_guided_work_checkpoint_revisions
    WHERE work_id = ?
    ORDER BY revision DESC
    LIMIT 1
  `).get(work.work_id);
  const actionProgress = checkpoint?.plan_revision_id === plan.plan_revision_id
    ? parseActionProgress(checkpoint.action_states_json)
    : [];
  const planReview = db.query<{
    verdict: string;
    bound_plan_revision_id: string | null;
  }, [string]>(`
    SELECT verdict, bound_plan_revision_id
    FROM btcc_guided_work_review_revisions
    WHERE work_id = ? AND subject = 'plan'
    ORDER BY revision DESC
    LIMIT 1
  `).get(work.work_id);
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
