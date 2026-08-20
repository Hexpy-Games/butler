import {
  APP_PROTOCOL_VERSION,
  type AppEventEnvelope,
} from "../../interface/protocol/app-protocol.ts";
import {
  isActiveSessionTurnState,
  maxMessageCursor,
  sessionHintForRow,
  sessionViewStatus,
} from "./session-read-model.ts";
import { createTranscriptExportStream } from "./session-transcript-export.ts";
import { isActiveWorkerActivity } from "../workers/worker-activity-read-model.ts";
import {
  encodeSessionCursor,
  type SessionMessagePageOptions,
  type SessionMessagePage,
  type TranscriptMessagePage,
} from "./session-message-page.ts";
import type {
  AutomationTargetSummary,
  ContextDetailsView,
  MessageRecord,
  SessionArtifactSummary,
  SessionSummary,
  SessionSummaryView,
  SessionView,
  SessionViewTurn,
  TranscriptExportStream,
  TranscriptExportView,
  TurnRecord,
  WorkerActivityListView,
} from "../../interface/protocol/app-protocol.ts";
import {
  emptyStewardProjection,
  projectStewardSession,
  type ProjectedStewardSession,
  type StewardObserverReader,
  type StewardObserverRelation,
} from "./steward-observer.ts";
import { sessionViewForStewardObserver } from "./steward-observer-view.ts";

export class AppSessionViewStore {
  constructor(
    private readonly getSession: (sessionId: string) => SessionSummary,
    private readonly latestTurn: (sessionId: string) => TurnRecord | null,
    private readonly listMessages: (sessionId: string) => MessageRecord[],
    private readonly listArtifactSummaries: (
      sessionId: string,
    ) => SessionArtifactSummary[],
    private readonly sessionViewMessages: (
      sessionId: string,
      options?: SessionMessagePageOptions,
    ) => SessionMessagePage<MessageRecord>,
    private readonly transcriptMessagePage: (
      sessionId: string,
      options?: SessionMessagePageOptions,
    ) => TranscriptMessagePage,
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
    private readonly stewardObserver: StewardObserverReader,
  ) {}

  getSessionSummary(sessionId: string): SessionSummaryView {
    const childRelation = this.stewardObserver.relationForChild(sessionId);
    if (childRelation) {
      const snapshot = this.stewardObserver.snapshot(sessionId);
      const projected = snapshot
        ? projectStewardSession(childRelation, snapshot)
        : emptyStewardProjection(childRelation);
      const latestProgress = projected.latest_turn?.progress ?? {
        summary: projected.result?.summary ?? "No progress yet",
        updated_at: projected.updated_at,
        state: "idle" as const,
        safe_progress_rows: projected.activity_rows,
      };
      return {
        session_id: projected.session_id,
        latest_progress: latestProgress,
        turn_state: projected.latest_turn?.state ?? "idle",
        branch_info: {
          available: false,
          workspace_mode: "none",
          safe_status: projected.status,
        },
        artifacts: projected.artifacts,
        skills_used: [],
        context_details: {
          session_id: projected.session_id,
          used_tokens: 0,
          budget_tokens: 0,
          ratio: 0,
          status: "low",
          categories: [],
          token_count_source: "unavailable",
          updated_at: projected.updated_at,
        },
        safe_errors: [],
        automation_targets: [],
        worker_activity: [],
        work_streams: [],
        staleness: {
          state: "fresh",
          updated_at: projected.updated_at,
          source: "btcc-observer",
        },
      };
    }
    const session = this.getSession(sessionId);
    const latestTurn = this.latestTurn(sessionId);
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
      artifacts: messages
        .flatMap((message) => message.artifacts ?? [])
        .slice(-20),
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
      steward_children: this.projectStewardChildren(sessionId),
    };
  }

  listStewardChildSummaries(sessionId: string): SessionSummary[] {
    return this.projectStewardChildren(sessionId).map((child) => ({
      id: child.session_id,
      kind: "chat",
      title: child.title,
      session_hint: `butler/steward-${child.session_id}`,
      created_at: child.relation.created_at,
      updated_at: child.updated_at,
      last_activity_at: child.updated_at,
      last_message_preview: child.result?.summary ?? child.active_turn?.progress.summary,
      active_turn_state: child.active_turn?.state,
      safe_status_label: child.active_turn?.progress.summary ?? child.result?.summary,
      unread_count: 0,
      pinned: false,
      archived: false,
      automation_target_count: 0,
      parent_session_id: child.relation.parent_session_id,
      is_steward_child: true,
    }));
  }

  getSessionView(
    sessionId: string,
    options: SessionMessagePageOptions = {},
  ): SessionView {
    const childRelation = this.stewardObserver.relationForChild(sessionId);
    if (childRelation) return this.getStewardSessionView(childRelation);
    const session = this.getSession(sessionId);
    const latestTurn = this.latestTurn(sessionId);
    const messagePage = this.sessionViewMessages(sessionId, options);
    const messages = messagePage.items;
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
    // Artifact history is independent from the message window: a caller may
    // request a 64-row page while the latest artifact lives just outside that
    // page. Keep the canonical bounded artifact query here rather than
    // silently shrinking the public artifact contract to the current page.
    const artifacts = this.listArtifacts(sessionId);
    const requestedAfterCursor = Number(options.afterCursor ?? 0);
    const nextCursor = maxMessageCursor(messages) || requestedAfterCursor;
    const firstCursor = Number(messages[0]?.cursor ?? 0);
    const afterCursor = requestedAfterCursor;
    const view: SessionView = {
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
        complete: !messagePage.hasMore,
        ...(firstCursor > 0 ? { previous_cursor: firstCursor } : {}),
        ...(firstCursor > 0
          ? { previous_cursor_token: encodeSessionCursor(session.id, firstCursor) }
          : {}),
        ...(options.beforeCursor !== undefined
          ? { requested_before_cursor: options.beforeCursor }
          : {}),
        ...(options.beforeCursorToken
          ? { requested_before_cursor_token: options.beforeCursorToken }
          : {}),
        ...(afterCursor > 0 ? { requested_cursor: afterCursor } : {}),
        ...(options.afterCursorToken
          ? { requested_cursor_token: options.afterCursorToken }
          : {}),
        ...(nextCursor > 0
          ? { next_cursor_token: encodeSessionCursor(session.id, nextCursor) }
          : {}),
        ...(messagePage.hasMore ? { has_more: true } : {}),
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
      steward_children: this.projectStewardChildren(sessionId),
    };
    return view;
  }

  listArtifacts(sessionId: string): SessionArtifactSummary[] {
    return this.listArtifactSummaries(sessionId);
  }

  exportTranscript(sessionId: string): TranscriptExportView {
    const stream = this.exportTranscriptStream(sessionId);
    const chunks: string[] = [];
    let messageCount = 0;
    for (const chunk of stream.chunks) {
      chunks.push(chunk.text);
      messageCount += chunk.message_count ?? 0;
    }
    return {
      session_id: stream.session_id,
      format: stream.format,
      filename: stream.filename,
      content: chunks.join(""),
      message_count: messageCount,
      generated_at: stream.generated_at,
    };
  }

  /**
   * Produce a full-history export one canonical page at a time. The HTTP
   * route consumes this iterable directly, keeping the gateway from retaining
   * MessageRecord[], Markdown lines, and the serialized JSON body together.
   */
  exportTranscriptStream(sessionId: string): TranscriptExportStream {
    const session = this.getSession(sessionId);
    const generatedAt = new Date().toISOString();
    return createTranscriptExportStream({
      sessionId,
      title: session.title,
      kind: session.kind,
      generatedAt,
      listPage: this.transcriptMessagePage,
    });
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

  private projectStewardChildren(
    parentSessionId: string,
  ): ProjectedStewardSession[] {
    const relation = this.stewardObserver.relationForParent(
      sessionHintForRow(parentSessionId),
    );
    if (!relation) return [];
    const snapshot = this.stewardObserver.snapshot(relation.child_session_id);
    return [
      snapshot
        ? projectStewardSession(relation, snapshot)
        : emptyStewardProjection(relation),
    ];
  }

  private getStewardSessionView(
    relation: StewardObserverRelation,
  ): SessionView {
    return sessionViewForStewardObserver(
      relation,
      this.stewardObserver.snapshot(relation.child_session_id),
      this.latestEventCursor(),
    );
  }
}
