import type { Database } from "bun:sqlite";
import type { ModelRef } from "../../../core/contracts.ts";
import type { GroupingCandidate, SessionClassification } from "../../../../agent/output/session-grouping.ts";
import type { SpaceNode } from "../../interface/protocol/space-contract.ts";
import { AppSpaceOrganization } from "./space-organization.ts";
import { normalizeTopic, SessionTopicCandidates, type TopicCandidate } from "./session-topic-candidates.ts";

export class AppSessionTopicGrouping {
  private readonly index = new SessionTopicCandidates();
  private readonly shutdown = new AbortController();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly input: {
    db: Database; space: AppSpaceOrganization; enabled(): boolean;
    classify(text: string, candidates: GroupingCandidate[], model: ModelRef, signal: AbortSignal): Promise<SessionClassification | null>;
  }) {}

  start(sessionId: string, messageId: string, text: string, model: ModelRef): Promise<void> {
    const existing = this.pending.get(sessionId);
    if (existing) return existing;
    const operation = Promise.resolve().then(() => this.classifyAndApply(sessionId, messageId, text, model))
      .catch(() => { /* Optional organization cannot fail the accepted conversation. */ })
      .finally(() => this.pending.delete(sessionId));
    this.pending.set(sessionId, operation);
    return operation;
  }

  close(): void { this.shutdown.abort(); }

  private eligible(sessionId: string, messageId: string): SpaceNode | undefined {
    if (this.shutdown.signal.aborted || !this.input.enabled() || sessionId === "general") return;
    const row = this.input.db.query<{ id: string }, [string]>(
      "SELECT id FROM messages WHERE chat_id=? AND role='user' ORDER BY rowid LIMIT 1",
    ).get(sessionId);
    if (row?.id !== messageId) return;
    const session = this.input.db.query<{ archived: number; project_id: string | null }, [string]>(
      "SELECT archived,project_id FROM chats WHERE id=?",
    ).get(sessionId);
    if (!session || session.archived || session.project_id) return;
    const node = this.input.space.read().nodes.find(item => item.key === `s:${sessionId}`);
    return node && !node.parentKey && !node.manualPlacement ? node : undefined;
  }

  private candidates(): TopicCandidate[] {
    return this.input.db.query<TopicCandidate, []>(`
      SELECT n.node_key AS key,'session' AS kind,c.title,t.topic,c.updated_at AS updatedAt,n.revision
      FROM app_space_nodes n JOIN chats c ON c.id=n.session_id
      LEFT JOIN app_space_topics t ON t.session_id=c.id
      WHERE c.project_id IS NULL AND c.archived=0 AND n.parent_key IS NULL AND n.manual_placement=0
        AND NOT EXISTS(SELECT 1 FROM app_session_branches b WHERE b.target_session_id=c.id AND b.state='prepared')
      UNION ALL
      SELECT n.node_key,'group',g.title,NULL,g.updated_at,n.revision
      FROM app_space_nodes n JOIN app_space_groups g ON g.id=n.group_id WHERE g.scope_project_id IS NULL
    `).all();
  }

  private async classifyAndApply(sessionId: string, messageId: string, text: string, model: ModelRef): Promise<void> {
    const source = this.eligible(sessionId, messageId);
    if (!source || this.input.db.query("SELECT 1 FROM app_space_topics WHERE session_id=?").get(sessionId)) return;
    this.index.sync(this.candidates());
    const candidates = this.index.choose(text.slice(0, 4096), source.key);
    const shortIds = candidates.map((item, index) => ({ id: String(index + 1), kind: item.kind, title: item.title, topic: item.topic }));
    const result = await this.input.classify(text, shortIds, model, this.shutdown.signal);
    if (!result?.topic || this.shutdown.signal.aborted) return;
    this.input.db.transaction(() => {
      const current = this.eligible(sessionId, messageId);
      if (!current || current.revision !== source.revision) return;
      const fresh = this.candidates();
      const selected = result.target ? candidates[shortIds.findIndex(item => item.id === result.target)] : undefined;
      const target = selected && fresh.find(item => item.key === selected.key && item.title === selected.title && item.revision === selected.revision);
      // Explicitly selected candidates must still describe the same node at application time.
      if (result.action !== "none" && !target) return;
      const topic = result.topic!;
      const normalized = normalizeTopic(topic);
      this.input.db.query("INSERT OR IGNORE INTO app_space_topics VALUES(?,?,?,?,?)")
        .run(sessionId, topic, normalized, messageId, new Date().toISOString());
      const group = result.action === "join_group" ? target :
        fresh.find(item => item.kind === "group" && normalizeTopic(item.title) === normalized);
      const peer = result.action === "group_sessions" ? target : this.input.db.query<{ key: string }, [string, string]>(`
        SELECT n.node_key AS key FROM app_space_topics t JOIN app_space_nodes n ON n.session_id=t.session_id
        JOIN chats c ON c.id=t.session_id WHERE t.topic_normalized=? AND t.session_id!=?
        AND n.parent_key IS NULL AND n.manual_placement=0 AND c.project_id IS NULL AND c.archived=0
        ORDER BY t.updated_at,t.session_id LIMIT 1
      `).get(normalized, sessionId);
      const revision = this.input.space.read().revision;
      if (group) this.input.space.execute({ action: "move", sourceKey: source.key,
        targetKey: group.key, position: "inside", expectedRevision: revision }, "smart", group.title);
      else if (peer) this.input.space.execute({ action: "group", sourceKey: source.key,
        targetKey: peer.key, expectedRevision: revision }, "smart", topic);
    })();
  }
}
