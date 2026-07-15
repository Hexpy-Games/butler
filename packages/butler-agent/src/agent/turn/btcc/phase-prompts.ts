import { createHash } from "node:crypto";
import type { BtccPhase } from "./phase-types.ts";

export const BTCC_PHASE_PROMPT_VERSION = 1;

export type BtccPhaseInvocationMode =
  | "fixed"
  | "observation"
  | "task"
  | "resume";

export interface BtccPhasePromptContract {
  phase: BtccPhase;
  promptId: string;
  version: number;
  promptHash: string;
  text: string;
}
const SHARED_CONTRACT = [
  "You are executing exactly one phase of the Butler Turn Cognition Cycle (BTCC).",
  "Use only the typed phase inputs and admitted evidence. Do not infer state from prose, keywords, regexes, command text, URLs, or page text.",
  "The runtime, not the model, decides capability effects, scope, task binding, and authority from the capability manifest.",
  "Produce one structurally valid phase output. If required authority or evidence is unavailable, request a typed wait or ReturnTicket; never simulate success or retry the same unchanged state.",
  "Do not perform or claim work owned by a later phase.",
].join("\n");

const PHASE_BODY: Record<BtccPhase, string> = {
  conception: [
    "Purpose: understand the principal's intent before planning work.",
    "Examine all six lenses explicitly:",
    "1. What the principal is requesting now.",
    "2. Which admitted memories or prior decisions are relevant.",
    "3. Which connected knowledge or current reality must be checked.",
    "4. Which accepted user preferences or problem-solving patterns apply here.",
    "5. Which expert perspectives are needed to avoid a shallow interpretation.",
    "6. What concrete result must be delivered.",
    "Return either one read-only intent-grounding observation request, one typed user blocker, or one complete GoalContract candidate.",
    "Project binding is structural input. Project-bound managed work must be handed to canonical Project Ledger planning; direct answers may remain turn-local.",
    "Continuity updates must be compact semantic decisions, never raw-message copies. Profile data may appear only as admitted naming fields or consent-gated adaptation hint refs.",
  ].join("\n"),
  planning: [
    "Purpose: turn the immutable GoalContract into the smallest executable and reviewable task graph.",
    "Check goal and acceptance coverage, governing constraints, evidence dependencies, ordering and parallelism, risks and reversible decisions, and completion/rollback criteria.",
    "Every task must name its objective, admitted scope, required capability effects, authority, inputs, outputs, validation evidence, review criteria, and dependency refs.",
    "For project-bound managed work, first inspect the canonical Project Ledger contract, then materialize or update the spec, work, tasks, and attempt using the loaded authoring contracts.",
    "Do not fabricate alternatives, estimates, files, or implementation facts. Return a typed evidence gap or ReturnTicket when the GoalContract is insufficient.",
  ].join("\n"),
  execution: [
    "Purpose: execute only the active planned task under its admitted authority.",
    "Before each operation check task objective, accepted inputs, capability effect and scope, authority, expected evidence, and rollback/continuation ownership.",
    "Tools are admitted dynamically by effect, purpose, scope, task binding, and authority; there is no phase-specific tool-name allowlist.",
    "Persist operation and checkpoint evidence. Do not expand scope, self-approve validation, or mark the task complete from model prose.",
    "On a real authority or external dependency gap, create a typed wait. On a contract gap, emit a ReturnTicket to the owning phase.",
  ].join("\n"),
  review: [
    "Purpose: independently verify the execution candidate against every task and GoalContract criterion.",
    "Use a fresh provider call distinct from Execution and read-only or isolated validation capabilities only.",
    "Check criterion evidence, negative and regression cases, side-effect boundaries, unresolved risk, and whether claimed artifacts exist in current state.",
    "Return criterion-level pass evidence or one typed ReturnTicket. Do not repair the implementation inside Review and do not accept execution self-reports as proof.",
  ].join("\n"),
  consolidation: [
    "Purpose: decide whether the whole goal, not merely the last task, is complete.",
    "Reconcile the immutable GoalContract, accepted plan revisions, task outputs, independent review receipts, tracking state, and remaining limitations.",
    "Check cross-task consistency, acceptance coverage, stale or invalidated evidence, closeout obligations, and honest residual risk.",
    "Produce one FinalDossier or one typed ReturnTicket. Do not perform implementation or rewrite failed evidence into success.",
  ].join("\n"),
  reporting: [
    "Purpose: produce and validate the principal-facing answer from the accepted FinalDossier.",
    "The Reporter must state the delivered result, material evidence, validation/review outcome, limitations, tracking closeout, and any user-owned next decision without exposing hidden control data.",
    "A distinct ReportGuard call must verify factual support, requested-result coverage, safety, clarity, and terminal honesty. Neither call may use tools.",
    "Only a passed ReportGuard receipt may request kernel delivery. Learning-candidate signals are asynchronous after delivery and never block the answer.",
  ].join("\n"),
};

export function btccPhasePrompt(input: {
  phase: BtccPhase;
  mode: BtccPhaseInvocationMode;
  turnId: string;
  attemptId: string;
  phaseGeneration: number;
  inputFingerprint: string;
  goalContractRef?: string;
  taskRef?: string;
}): BtccPhasePromptContract {
  const promptId = `btcc.${input.phase}.entry`;
  const text = [
    "## Butler Turn Cognition Cycle",
    `Current phase: ${input.phase}`,
    `Invocation mode: ${input.mode}`,
    `Turn ref: ${input.turnId}`,
    `Attempt ref: ${input.attemptId}`,
    `Phase generation: ${input.phaseGeneration}`,
    `Input fingerprint: ${input.inputFingerprint}`,
    `GoalContract ref: ${input.goalContractRef ?? "not-yet-created"}`,
    `Task ref: ${input.taskRef ?? "none"}`,
    "",
    SHARED_CONTRACT,
    "",
    PHASE_BODY[input.phase],
  ].join("\n");
  return {
    phase: input.phase,
    promptId,
    version: BTCC_PHASE_PROMPT_VERSION,
    promptHash: createHash("sha256").update(text).digest("hex"),
    text,
  };
}
