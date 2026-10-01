/**
 * Agent readiness during first run (#230, agent side in #279).
 *
 * Two sources: the desktop app's local preparation (`POST /setup/start`:
 * install and start the agent service) and the agent's own preparation
 * (`GET /setup/readiness`, `POST /setup/readiness/retry` and the live event
 * `setup.readiness_changed`). Agent steps: `data_folder`, `model_config`,
 * `agent_runtime`.
 */
export type SetupReadinessStatus = "preparing" | "ready" | "failed";
export type SetupReadinessStepStatus = "pending" | "running" | "done" | "failed";

export interface SetupReadinessStep {
  id: string;
  status: SetupReadinessStepStatus;
  /** A failed step: a stable `code` the app maps to a plain reason, and an English `detail` for bug reports. */
  error?: { code: string; detail?: string };
}

export interface MemoryModelProgress {
  state: "queued" | "downloading" | "verifying" | "ready" | "failed";
  bytes_done: number;
  bytes_total: number;
  reason?: string;
}

export interface SetupReadinessView {
  memory_model?: MemoryModelProgress;
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
  const error = record.error as { code?: unknown; detail?: unknown } | null | undefined;
  return {
    id: record.id,
    status: record.status as SetupReadinessStepStatus,
    ...(typeof error?.code === "string"
      ? { error: { code: error.code, ...(typeof error.detail === "string" ? { detail: error.detail } : {}) } }
      : {}),
  };
}

/** A validated readiness view, or null for anything else. */
export function normalizeReadiness(value: unknown): SetupReadinessView | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!STATUSES.includes(record.status as SetupReadinessStatus)) return null;
  const steps = Array.isArray(record.steps) ? record.steps.map(normalizeStep).filter((step) => step !== null) : [];
  const model = record.memory_model as MemoryModelProgress | undefined;
  const validModel = model && ["queued", "downloading", "verifying", "ready", "failed"].includes(model.state)
    && Number.isFinite(model.bytes_done) && Number.isFinite(model.bytes_total);
  return { status: record.status as SetupReadinessStatus, steps, ...(validModel ? { memory_model: model } : {}) };
}

/** Readiness from a `setup.readiness_changed` event; its payload is the view. */
export function readinessFromEvent(event: { type: string; payload?: unknown }): SetupReadinessView | null {
  return event.type === SETUP_READINESS_EVENT ? normalizeReadiness(event.payload) : null;
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
