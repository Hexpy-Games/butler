/**
 * Agent readiness during first run (#230 contract).
 *
 * Two sources: the desktop app's local preparation (`POST /setup/start`:
 * install and start the agent service) and the agent's own preparation
 * (`GET /setup/readiness` plus the live event `setup.readiness_changed`,
 * implemented by the Rust agent in #230).
 */
export type SetupReadinessStatus = "preparing" | "ready" | "failed";
export type SetupReadinessStepStatus = "pending" | "running" | "done" | "failed";

export interface SetupReadinessStep {
  id: string;
  status: SetupReadinessStepStatus;
  /** Stable code for a failed step; the app maps it to a plain reason. */
  error?: { code: string };
}

export interface SetupReadinessView {
  status: SetupReadinessStatus;
  steps: SetupReadinessStep[];
}

/** Local preparation by the desktop app, from `POST /setup/start`. */
export interface LocalPreparation {
  phase: "checking" | "ready" | "failed";
  error_code?: string;
}

/** #230 live event carrying the agent readiness view. */
export const SETUP_READINESS_EVENT = "setup.readiness_changed";

const STATUSES: readonly SetupReadinessStatus[] = ["preparing", "ready", "failed"];
const STEP_STATUSES: readonly SetupReadinessStepStatus[] = ["pending", "running", "done", "failed"];

function normalizeStep(value: unknown): SetupReadinessStep | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !STEP_STATUSES.includes(record.status as SetupReadinessStepStatus)) return null;
  const code = (record.error as { code?: unknown } | null | undefined)?.code;
  return {
    id: record.id,
    status: record.status as SetupReadinessStepStatus,
    ...(typeof code === "string" ? { error: { code } } : {}),
  };
}

/** A validated readiness view, or null for anything else. */
export function normalizeReadiness(value: unknown): SetupReadinessView | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!STATUSES.includes(record.status as SetupReadinessStatus)) return null;
  const steps = Array.isArray(record.steps) ? record.steps.map(normalizeStep).filter((step) => step !== null) : [];
  return { status: record.status as SetupReadinessStatus, steps };
}

/** Readiness from a `setup.readiness_changed` event (payload or payload.readiness). */
export function readinessFromEvent(event: { type: string; payload?: unknown }): SetupReadinessView | null {
  if (event.type !== SETUP_READINESS_EVENT) return null;
  const payload = event.payload as { readiness?: unknown } | undefined;
  return normalizeReadiness(payload?.readiness ?? payload);
}

/**
 * The readiness the first run shows. Local preparation must finish first;
 * then the agent's view decides. `unsupported` is an agent without the #230
 * route, which has nothing more to prepare.
 */
export function combineReadiness(
  local: LocalPreparation,
  agent: SetupReadinessView | "unsupported" | null,
): SetupReadinessView {
  const agentSteps = agent && agent !== "unsupported" ? agent.steps : [];
  if (local.phase === "failed") {
    return {
      status: "failed",
      steps: [{ id: "agent_service", status: "failed", error: { code: local.error_code ?? "setup_failed" } }],
    };
  }
  if (local.phase === "checking") return { status: "preparing", steps: agentSteps };
  if (agent === "unsupported") return { status: "ready", steps: [] };
  return agent ?? { status: "preparing", steps: [] };
}

/** Finished and total steps, or null while the steps are unknown. */
export function readinessProgress(view: SetupReadinessView): { done: number; total: number } | null {
  if (view.steps.length === 0) return null;
  return { done: view.steps.filter((step) => step.status === "done").length, total: view.steps.length };
}

/** The code of the first failed step, or `default`. */
export function readinessFailureCode(view: SetupReadinessView): string {
  return view.steps.find((step) => step.status === "failed" && step.error?.code)?.error?.code ?? "default";
}
