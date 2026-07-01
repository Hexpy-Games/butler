import { APP_PROTOCOL_VERSION, type AppEventEnvelope } from "../../interface/protocol/app-protocol.ts";
import {
  isActiveSessionTurnState,
  maxMessageCursor,
  safeLocalSessionId,
  sessionHintForRow,
  sessionViewStatus,
} from "./session-read-model.ts";
import { isActiveWorkerActivity } from "../workers/worker-activity-read-model.ts";
import type {
  AutomationTargetSummary,
  ContextDetailsView,
  MessageRecord,
  SessionArtifactSummary,
  SessionSummary,
  SessionSummaryView,
  SessionView,
  SessionViewTurn,
  TranscriptExportView,
  TurnRecord,
  WorkerActivityListView,
} from "../../interface/protocol/app-protocol.ts";

export class AppSessionViewStore {
  constructor(
    private readonly getSession: (sessionId: string) => SessionSummary,
    private readonly listTurns: (sessionId: string) => TurnRecord[],
    private readonly listMessages: (sessionId: string) => MessageRecord[],
    private readonly sessionViewMessages: (sessionId: string) => MessageRecord[],
    private readonly sessionViewTurn: (
      turn: TurnRecord,
      options?: { suppressProgressRows?: boolean },
    ) => SessionViewTurn,
    private readonly branchInfoForSession: (
      sessionId: string,
    ) => SessionSummaryView["branch_info"],
    private readonly loadedSkillNamesForSession: (
      sessionId: string,
      turnId?: string,
    ) => string[],
    private readonly getContextDetails: (
      sessionId: string,
    ) => ContextDetailsView,
    private readonly listAutomationTargets: (
      sessionId: string,
    ) => AutomationTargetSummary[],
    private readonly listWorkerActivity: (options: {
      sessionId?: string;
      includeHistory?: boolean;
    }) => WorkerActivityListView,
    private readonly listActiveWorkStreams: (
      sessionId: string,
      runtimeSessionId?: string,
      currentTurnId?: string,
    ) => SessionView["work_streams"],
    private readonly latestEventCursor: () => AppEventEnvelope["id"],
    private readonly ensureChat: (sessionId: string) => void,
  ) {}

  getSessionSummary(sessionId: string): SessionSummaryView {
    const session = this.getSession(sessionId);
    const turns = this.listTurns(sessionId);
    const latestTurn = turns.at(-1);
    const messages = this.listMessages(sessionId);
    const latestProgress = latestTurn
      ? this.sessionViewTurn(latestTurn).progress
      : {
          summary: messages.at(-1)
            ? "Latest message delivered"
            : "No progress yet",
          updated_at: session.updated_at,
          state: "idle" as const,
          safe_progress_rows: [],
        };
    const activeWorkStreamTurnId =
      latestTurn && isActiveSessionTurnState(latestTurn.state)
        ? latestTurn.id
        : undefined;
    return {
      session_id: session.id,
      latest_progress: latestProgress,
      turn_state: latestTurn?.state ?? "idle",
      branch_info: this.branchInfoForSession(sessionId),
      artifacts: messages.flatMap((message) => message.artifacts ?? []).slice(-20),
      skills_used: this.loadedSkillNamesForSession(sessionId, latestTurn?.id),
      context_details: this.getContextDetails(sessionId),
      safe_errors: this.safeErrors(messages),
      automation_targets: this.listAutomationTargets(sessionId),
      worker_activity: this.listWorkerActivity({
        sessionId,
        includeHistory: false,
      }).workers.filter(isActiveWorkerActivity),
      work_streams: this.listActiveWorkStreams(
        sessionId,
        undefined,
        activeWorkStreamTurnId,
      ),
      staleness: {
        state: "fresh",
        updated_at: new Date().toISOString(),
        source: "app-server",
      },
    };
  }

  getSessionView(sessionId: string): SessionView {
    const session = this.getSession(sessionId);
    const turns = this.listTurns(sessionId);
    const latestTurn = turns.at(-1);
    const messages = this.sessionViewMessages(sessionId);
    const latestMessage = messages.at(-1);
    const latestTurnHasOutOfBandReport = Boolean(
      latestTurn &&
        !latestTurn.user_message_id &&
        latestTurn.state === "delivered" &&
        latestMessage?.role === "assistant" &&
        !latestMessage.turn_id &&
        latestMessage.created_at >= latestTurn.created_at,
    );
    const latestTurnView = latestTurn
      ? this.sessionViewTurn(latestTurn, {
          suppressProgressRows: latestTurnHasOutOfBandReport,
        })
      : null;
    const activeTurn =
      latestTurnView && isActiveSessionTurnState(latestTurnView.state)
        ? latestTurnView
        : null;
    const runtimeSessionId = sessionHintForRow(sessionId);
    const activeWorkStreamTurnId = activeTurn?.id;
    const workStreams = this.listActiveWorkStreams(
      sessionId,
      runtimeSessionId,
      activeWorkStreamTurnId,
    );
    const artifacts = this.listArtifacts(sessionId);
    const nextCursor = maxMessageCursor(messages);
    return {
      protocol_version: APP_PROTOCOL_VERSION,
      session_id: session.id,
      kind: session.kind,
      project_id: session.project_id,
      status: sessionViewStatus(latestTurnView?.state),
      active_turn: activeTurn,
      latest_turn: latestTurnView,
      messages,
      message_window: {
        next_cursor: nextCursor,
        complete: messages.length < 200,
      },
      workers: this.listWorkerActivity({
        sessionId,
        includeHistory: false,
      }).workers,
      work_streams: workStreams,
      artifacts,
      context: this.getContextDetails(sessionId),
      branch: this.branchInfoForSession(sessionId),
      skills_used: this.loadedSkillNamesForSession(sessionId, latestTurn?.id),
      automations: this.listAutomationTargets(sessionId),
      errors: this.safeErrors(messages),
      cursors: {
        messages: nextCursor,
        events: this.latestEventCursor(),
      },
      generated_at: new Date().toISOString(),
      updated_at:
        latestTurnView?.updated_at ??
        latestMessage?.updated_at ??
        session.updated_at,
    };
  }

  listArtifacts(sessionId: string): SessionArtifactSummary[] {
    this.ensureChat(sessionId);
    return this.listMessages(sessionId)
      .flatMap((message) => message.artifacts ?? [])
      .slice(-20);
  }

  exportTranscript(sessionId: string): TranscriptExportView {
    const session = this.getSession(sessionId);
    const messages = this.listMessages(sessionId).filter(
      (message) =>
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "automation" ||
        message.role === "system_event",
    );
    const lines = [
      `# ${session.title}`,
      "",
      `Session: ${session.kind}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      ...messages.flatMap((message) => [
        `## ${message.role}`,
        "",
        message.text,
        "",
      ]),
    ];
    return {
      session_id: sessionId,
      format: "markdown",
      filename: `${safeLocalSessionId(session.title)}.md`,
      content: lines.join("\n"),
      message_count: messages.length,
      generated_at: new Date().toISOString(),
    };
  }

  private safeErrors(messages: MessageRecord[]): SessionView["errors"] {
    return messages
      .filter((message) => message.safe_error_code)
      .slice(-5)
      .map((message) => ({
        code: message.safe_error_code!,
        message: "A safe app-visible error occurred.",
        created_at: message.updated_at,
      }));
  }
}
