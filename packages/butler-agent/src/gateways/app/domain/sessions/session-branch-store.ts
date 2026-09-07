import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { SessionBranchRequest, SessionBranchSeed } from "../../../../foundation/session-branch.ts";
import type { MessageRecord, SessionSummary } from "../../interface/protocol/app-protocol.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { readBranchAnswer, readBranchContext, resolveBranchSessionId } from "./session-branch-context.ts";

type BranchRow = { request_id: string; input_digest: string; target_session_id: string; seed_json: string; source_json: string; state: "prepared" | "ready" };
export interface SessionBranchResult { session: SessionSummary; seed: SessionBranchSeed }

/** A saved seed and target identity survive provisioning failures and retries. */
export class AppSessionBranchStore {
  private readonly running = new Map<string, { digest: string; promise: Promise<SessionBranchResult> }>();
  constructor(private readonly input: {
    db: Database;
    butlerData: string;
    getSession(id: string): SessionSummary;
    getMessage(id: string): MessageRecord;
    createSession(request: { kind: "chat" | "project"; project_id?: string; title: string; session_hint: string }): SessionSummary;
    createProject(name: string): { id: string };
    provision(id: string, signal: AbortSignal | undefined, requestId: string): Promise<void>;
    publish(id: string): void;
    summarize(text: string, signal?: AbortSignal): Promise<{ summary: string; excerptTruncated: boolean }>;
  }) {}

  branch(request: SessionBranchRequest, signal?: AbortSignal): Promise<SessionBranchResult> {
    this.validate(request);
    const digest = createHash("sha256").update(JSON.stringify([
      request.sourceSessionId, request.sourceMessageId, request.title,
      request.destination.kind,
      request.destination.kind === "project" ? request.destination.projectId :
        request.destination.kind === "new_project" ? request.destination.name : null,
      request.followUp ?? null,
    ])).digest("hex");
    const running = this.running.get(request.requestId);
    if (running) {
      if (running.digest !== digest) this.conflict();
      return running.promise;
    }
    const promise = this.perform(request, digest, signal).finally(() => this.running.delete(request.requestId));
    this.running.set(request.requestId, { digest, promise });
    return promise;
  }

  seed(sessionId: string): SessionBranchSeed | undefined {
    return readSessionBranchSeed(this.input.db, sessionId);
  }

  async fromTool(args: Record<string, unknown>, signal?: AbortSignal): Promise<SessionBranchResult> {
    const requestId = typeof args.request_id === "string" ? args.request_id : "";
    const prior = this.row(requestId);
    const saved = prior ? JSON.parse(prior.source_json) as SessionBranchRequest : undefined;
    const requestedSource = args.source_session_id ?? saved?.sourceSessionId ?? args.current_session_id;
    if (typeof requestedSource !== "string") throw new AppStoreOperationError(400, "branch_source_required", "출처 대화가 필요합니다.");
    const sourceId = resolveBranchSessionId(this.input.db, this.input.butlerData, requestedSource);
    this.input.getSession(sourceId);
    const requestedMessage = args.source_message_id ?? saved?.sourceMessageId;
    if (requestedMessage !== undefined && typeof requestedMessage !== "string") {
      throw new AppStoreOperationError(400, "branch_source_invalid", "출처 메시지를 확인해 주세요.");
    }
    const source = readBranchAnswer(this.input.db, this.input.butlerData, sourceId, requestedMessage as string | undefined);
    if (!source) throw new AppStoreOperationError(404, "branch_source_unavailable", "분리할 완료된 답변이 없습니다.");
    const request = { requestId, sourceSessionId: sourceId, sourceMessageId: source.id,
      title: args.title,
      destination: args.destination === "new_project" ? { kind: "new_project", name: args.title } :
        args.destination === "project" ? { kind: "project", projectId: args.project_id } : { kind: args.destination },
      ...(args.follow_up !== undefined ? { followUp: args.follow_up } : {}),
    } as SessionBranchRequest;
    return this.branch(request, signal);
  }

  private async perform(request: SessionBranchRequest, digest: string, signal?: AbortSignal): Promise<SessionBranchResult> {
    let row = this.row(request.requestId);
    if (row && row.input_digest !== digest) this.conflict();
    if (!row) {
      this.input.getSession(request.sourceSessionId);
      const message = readBranchAnswer(this.input.db, this.input.butlerData, request.sourceSessionId, request.sourceMessageId)
        ?? this.input.getMessage(request.sourceMessageId);
      if (message.chat_id !== request.sourceSessionId || message.role !== "assistant" ||
        !["delivered", "completed", "sent"].includes(message.status ?? "")) {
        throw new AppStoreOperationError(400, "branch_source_invalid", "이 대화의 답변을 선택해 주세요.");
      }
      const source = readBranchContext(this.input.db, this.input.butlerData, message);
      const summary = await this.input.summarize(source, signal);
      if (signal?.aborted) throw new AppStoreOperationError(409, "branch_cancelled", "새 대화 만들기가 취소되었습니다.");
      const seed: SessionBranchSeed = { ...summary, sourceSessionId: request.sourceSessionId,
        sourceMessageId: request.sourceMessageId, sourceThroughMessageId: request.sourceMessageId,
        canonicalSessionId: message.conversation_session_id ?? null,
        canonicalMessageId: message.conversation_message_id ?? null };
      row = this.input.db.transaction(() => {
        const concurrent = this.row(request.requestId);
        if (concurrent) { if (concurrent.input_digest !== digest) this.conflict(); return concurrent; }
        const projectId = request.destination.kind === "new_project"
          ? this.input.createProject(request.destination.name).id
          : request.destination.kind === "project" ? request.destination.projectId : undefined;
        const session = this.input.createSession({ kind: projectId ? "project" : "chat", title: request.title,
          ...(projectId ? { project_id: projectId } : {}),
          session_hint: `chat-${crypto.randomUUID()}` });
        this.input.db.query("INSERT INTO app_session_branches VALUES(?,?,?,?,?,'prepared')")
          .run(request.requestId, digest, session.id, JSON.stringify(request), JSON.stringify(seed));
        return this.row(request.requestId)!;
      })();
    }
    if (row.state !== "ready") {
      await this.input.provision(row.target_session_id, signal, request.requestId);
      this.input.db.transaction(() => {
        const changed = this.input.db.query("UPDATE app_session_branches SET state='ready' WHERE request_id=? AND state='prepared'").run(request.requestId);
        if (changed.changes) this.input.publish(row!.target_session_id);
      })();
    }
    return { session: this.input.getSession(row.target_session_id), seed: JSON.parse(row.seed_json) };
  }

  private row(id: string): BranchRow | null {
    return this.input.db.query<BranchRow, [string]>("SELECT * FROM app_session_branches WHERE request_id=?").get(id);
  }
  private conflict(): never { throw new AppStoreOperationError(409, "branch_identity_conflict", "같은 생성 요청의 내용이 변경되었습니다."); }
  private validate(request: SessionBranchRequest): void {
    if (!request || typeof request.requestId !== "string" || !request.requestId.trim() ||
      typeof request.sourceSessionId !== "string" || typeof request.sourceMessageId !== "string" ||
      typeof request.title !== "string" || !request.title.trim() || !request.destination ||
      !["chat", "project", "new_project"].includes(request.destination.kind) ||
      (request.followUp !== undefined && typeof request.followUp !== "string") ||
      (request.destination.kind === "project" &&
        (typeof request.destination.projectId !== "string" || !request.destination.projectId.trim())) ||
      (request.destination.kind === "new_project" &&
        (typeof request.destination.name !== "string" || !request.destination.name.trim()))) {
      throw new AppStoreOperationError(400, "branch_request_invalid", "새 대화의 제목과 출처를 확인해 주세요.");
    }
  }
}

export function readSessionBranchSeed(db: Database, sessionId: string): SessionBranchSeed | undefined {
  const row = db.query<{ seed_json: string }, [string]>(
    "SELECT seed_json FROM app_session_branches WHERE target_session_id=? AND state='ready'",
  ).get(sessionId);
  return row ? JSON.parse(row.seed_json) : undefined;
}
