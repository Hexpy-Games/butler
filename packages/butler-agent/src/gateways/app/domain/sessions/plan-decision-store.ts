import { ActiveProjectLedgerResolver } from
  "../../../../integrations/project-ledger/active-project-ledger-reference.ts";
import { runProjectLedgerTool } from
  "../../../../integrations/project-ledger/client.ts";
import type { ProjectLedgerPlan } from
  "../../../../agent/btcc/project-plan.ts";
import { projectLedgerPlanFromRecordResult } from
  "../../../../agent/btcc/project-plan.ts";
import type {
  ChatRow,
  ProjectRow,
} from "../../infrastructure/core/records.ts";
import { AppStoreOperationError } from
  "../../infrastructure/core/app-store-errors.ts";
import type {
  PlanDecisionRequest,
  PlanDecisionResult,
  ProjectDashboardDocument,
  SessionControlsView,
  SessionQueueView,
} from "../../interface/protocol/app-protocol.ts";

type PlanDecisionStoreInput = {
  butlerData: string;
  butlerHome: string;
  getChatRow: (sessionId: string) => ChatRow | null;
  getProjectRow: (projectId: string) => ProjectRow | null;
  listMessages: (sessionId: string) => import("../../interface/protocol/app-protocol.ts").MessageRecord[];
  sessionHasActiveTurn: (sessionId: string) => boolean;
  updateSessionControlsView: (
    sessionId: string,
    input: { plan_mode?: boolean },
  ) => SessionControlsView;
  createQueuedMessage: (input: {
    chat_id: string;
    text: string;
    client_message_id: string;
    plan_mode: boolean;
    plan_id?: string;
  }) => Promise<SessionQueueView>;
  drainQueuedSessionMessages: (sessionId: string) => Promise<void>;
  listSessionQueue: (sessionId: string) => SessionQueueView;
  appendEvent: (type: string, payload: Record<string, unknown>) => void;
};

/** Owns the typed, session-bound decision path for a Project Ledger Plan. */
export class AppPlanDecisionStore {
  private readonly decisionLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly input: PlanDecisionStoreInput) {}

  async decide(
    sessionId: string,
    planId: string,
    decision: PlanDecisionRequest,
  ): Promise<PlanDecisionResult> {
    const normalizedSessionId = sessionId.trim();
    const normalizedPlanId = planId.trim();
    if (!normalizedSessionId || !normalizedPlanId || normalizedPlanId.length > 256) {
      throw new AppStoreOperationError(
        400,
        "invalid_plan_reference",
        "A session and Project Ledger Plan are required.",
      );
    }
    const key = `${normalizedSessionId}\u0000${normalizedPlanId}`;
    const previous = this.decisionLocks.get(key) ?? Promise.resolve();
    const current = previous.then(() => this.decideLocked(
      normalizedSessionId,
      normalizedPlanId,
      decision,
    ));
    const tracked = current.finally(() => {
      if (this.decisionLocks.get(key) === tracked) this.decisionLocks.delete(key);
    });
    this.decisionLocks.set(key, tracked);
    return await current;
  }

  private async decideLocked(
    sessionId: string,
    planId: string,
    decision: PlanDecisionRequest,
  ): Promise<PlanDecisionResult> {
    const chat = this.input.getChatRow(sessionId);
    if (!chat) {
      throw new AppStoreOperationError(404, "session_not_found", "Session not found.");
    }
    if (!chat.project_id) {
      throw new AppStoreOperationError(
        409,
        "plan_project_required",
        "Plan mode is available only in a project session.",
      );
    }
    const project = this.input.getProjectRow(chat.project_id);
    const ledgerProjectId = project?.ledger_project_id?.trim();
    if (!project || !ledgerProjectId) {
      throw new AppStoreOperationError(
        409,
        "project_ledger_identity_missing",
        "This project has no canonical Project Ledger identity.",
      );
    }
    const ledgerRoot = this.resolveLedgerRoot(project.id, ledgerProjectId);
    const projectedPlan = [...this.input.listMessages(sessionId)]
      .reverse()
      .find((message) => message.role === "assistant" &&
        message.plan_document?.id === planId)?.plan_document;
    if (!projectedPlan || projectedPlan.status !== "draft") {
      throw new AppStoreOperationError(
        409,
        "plan_not_awaiting_decision",
        "This Plan is not awaiting a decision in this session.",
      );
    }
    let plan = this.readPlan(ledgerRoot, planId);
    if (!plan) {
      throw new AppStoreOperationError(404, "plan_not_found", "Project Ledger Plan not found.");
    }
    if (plan.status !== "draft") {
      throw new AppStoreOperationError(
        409,
        "plan_decision_conflict",
        "This Project Ledger Plan has already received a decision.",
      );
    }
    const pendingPlanMessage = this.input.listSessionQueue(sessionId).queued_messages
      .some((message) => message.plan_id === planId && message.state === "queued");
    if (this.input.sessionHasActiveTurn(sessionId) || pendingPlanMessage) {
      throw new AppStoreOperationError(
        409,
        "plan_decision_in_progress",
        "The current Plan decision is still being processed.",
      );
    }

    if (decision.action === "accept" || decision.action === "reject") {
      const status = decision.action === "accept" ? "active" : "rejected";
      this.updatePlan(ledgerRoot, planId, status);
      plan = this.readPlan(ledgerRoot, planId);
      if (!plan) throw new Error("project_ledger_plan_disappeared_after_update");
      const controls = this.input.updateSessionControlsView(sessionId, {
        plan_mode: false,
      });
      const queued = decision.action === "accept"
        ? await this.queueContinuation({
            chat_id: sessionId,
            client_message_id: `client-plan-accept-${crypto.randomUUID()}`,
            plan_id: plan.id,
            text: `Proceed with the accepted plan "${plan.title}".`,
            plan_mode: false,
          })
        : undefined;
      this.recordDecision(sessionId, plan, decision.action);
      return {
        plan_document: planDocument(plan),
        controls,
        ...(queued ? { queued } : {}),
      };
    }

    const instruction = decision.instruction?.trim();
    if (!instruction) {
      throw new AppStoreOperationError(
        400,
        "plan_instruction_required",
        "A direct Plan instruction is required.",
      );
    }
    const queued = await this.queueContinuation({
      chat_id: sessionId,
      client_message_id: `client-plan-instruct-${crypto.randomUUID()}`,
      plan_id: plan.id,
      text: instruction,
      plan_mode: true,
    });
    const controls = this.input.updateSessionControlsView(sessionId, {
      plan_mode: true,
    });
    this.recordDecision(sessionId, plan, decision.action);
    return {
      plan_document: planDocument(plan),
      controls,
      queued,
    };
  }

  private async queueContinuation(input: {
    chat_id: string;
    text: string;
    client_message_id: string;
    plan_mode: boolean;
    plan_id: string;
  }): Promise<SessionQueueView> {
    await this.input.createQueuedMessage(input);
    await this.input.drainQueuedSessionMessages(input.chat_id);
    return this.input.listSessionQueue(input.chat_id);
  }

  private resolveLedgerRoot(appProjectId: string, ledgerProjectId: string): string {
    try {
      const reference = new ActiveProjectLedgerResolver().resolve({
        butlerData: this.input.butlerData,
        appProjectId,
        explicitRef: ledgerProjectId,
      });
      if (reference.ledger_project_id !== ledgerProjectId) {
        throw new Error("project_ledger_identity_mismatch");
      }
      return reference.ledger_root;
    } catch {
      throw new AppStoreOperationError(
        409,
        "project_ledger_resolution_failed",
        "The canonical Project Ledger for this project could not be resolved.",
      );
    }
  }

  private readPlan(
    ledgerRoot: string,
    planId: string,
  ): ProjectLedgerPlan | undefined {
    const result = runProjectLedgerTool(
      { butlerHome: this.input.butlerHome, butlerData: this.input.butlerData },
      ["record", "show", "--project", ledgerRoot, "--kind", "plan", "--id", planId, "--body"],
    );
    return projectLedgerPlanFromRecordResult(result, planId);
  }

  private updatePlan(
    ledgerRoot: string,
    planId: string,
    status: "active" | "rejected",
  ): void {
    const result = runProjectLedgerTool(
      { butlerHome: this.input.butlerHome, butlerData: this.input.butlerData },
      ["record", "update", "--project", ledgerRoot, "--kind", "plan", "--id", planId, "--status", status],
    );
    if (result.ok === false) {
      throw new AppStoreOperationError(
        409,
        "plan_update_failed",
        "Project Ledger Plan could not be updated.",
      );
    }
  }

  private recordDecision(
    sessionId: string,
    plan: ProjectLedgerPlan,
    action: PlanDecisionRequest["action"],
  ): void {
    this.input.appendEvent("session.plan_decision", {
      session_id: sessionId,
      plan_id: plan.id,
      action,
      status: plan.status,
    });
  }
}

function planDocument(plan: ProjectLedgerPlan): ProjectDashboardDocument {
  const safeId = plan.id.replace(/[^a-z0-9._/-]+/giu, "-");
  return {
    id: plan.id,
    kind: "plan",
    document_type: "plan",
    title: plan.title,
    status: plan.status,
    safe_path_label: `plans/${safeId}.md`,
    markdown: plan.body,
    updated_at: new Date().toISOString(),
  };
}
