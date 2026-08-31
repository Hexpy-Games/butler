import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ensureAppMessageQuerySchema } from "./message-query-schema.ts";
import { ensureColumn, tableExists } from "./schema-migration.ts";
import { ensureTerminalRetentionSchema } from "../retention/schema.ts";
import { initializeProjectLedgerBindings } from "./project-ledger-binding-migration.ts";

const DEFAULT_CHAT_ID = "general";
const DEFAULT_CHAT_TITLE = "Onboarding";
const DEFAULT_PROJECT_ID = "butler";

export function migrateAppStoreSchema(
  db: Database,
  options: { butlerData?: string } = {},
): void {
  const turnsTableIsNew = !tableExists(db, "turns");
  const eventsTableIsNew = !tableExists(db, "events");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      project_id TEXT,
      conversation_session_id TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_label TEXT NOT NULL,
      safe_path_label TEXT NOT NULL,
      ledger_project_id TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      turn_id TEXT,
      conversation_session_id TEXT,
      conversation_turn_id TEXT,
      conversation_message_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      safe_error_code TEXT,
      retryable INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS message_files (
      id TEXT PRIMARY KEY,
      owner_session_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      safe_name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL REFERENCES message_files(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY (message_id, file_id)
    );

    CREATE TABLE IF NOT EXISTS message_changed_files (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      safe_path_label TEXT NOT NULL,
      detail_json TEXT,
      PRIMARY KEY (message_id, position)
    );

    CREATE TABLE IF NOT EXISTS session_queued_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      client_message_id TEXT,
      input_identity_digest TEXT,
      control_resolution_json TEXT,
      controls_json TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      safe_error_code TEXT,
      dispatched_message_id TEXT,
      turn_id TEXT,
      claim_id TEXT,
      claim_owner TEXT,
      claimed_at TEXT,
      lease_expires_at TEXT,
      terminal_result_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_message_id TEXT,
      state TEXT NOT NULL,
      safe_status_label TEXT NOT NULL,
      safe_error_code TEXT,
      retryable INTEGER NOT NULL DEFAULT 0,
      cancellable INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 1,
      execution_controls_json TEXT,
      execution_model_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_turn_cancel_outbox (
      turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
      queue_id TEXT,
      dispatch_claim_id TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      completed_at TEXT,
      safe_error_code TEXT
    );

    CREATE TABLE IF NOT EXISTS app_operation_output_chunks (
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      result_id TEXT NOT NULL,
      result_sha256 TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      byte_start INTEGER NOT NULL,
      byte_end INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      content_base64 TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (turn_id, request_id, result_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS app_operation_output_result_idx
    ON app_operation_output_chunks(turn_id, result_id, chunk_index);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      turn_id TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projected_transport_events (
      action_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_transport_projection_receipts (
      action_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_transport_projection_migrations (
      name TEXT PRIMARY KEY,
      cursor_action_id TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_transport_projection_staged_outbounds (
      action_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('awaiting_delivery', 'deferred_final')
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS app_transport_staged_state_action_idx
    ON app_transport_projection_staged_outbounds(state, action_id);

    CREATE TABLE IF NOT EXISTS app_transcript_projection_checkpoints (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      file_device INTEGER NOT NULL,
      file_inode INTEGER NOT NULL,
      projected_bytes INTEGER NOT NULL,
      modified_at_ms INTEGER NOT NULL,
      trailing_text TEXT NOT NULL,
      boundary_anchor_text TEXT NOT NULL DEFAULT '',
      spool_path TEXT NOT NULL DEFAULT '',
      spool_bytes INTEGER NOT NULL DEFAULT 0,
      spool_end_offset INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_conversation_projection_state (
      gateway TEXT PRIMARY KEY,
      last_outbox_id TEXT,
      last_outcome_id TEXT,
      updated_at TEXT NOT NULL,
      pending_count INTEGER NOT NULL DEFAULT 0,
      safe_error_code TEXT
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_automations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt_body TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_session_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      interval_seconds INTEGER NOT NULL,
      state TEXT NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      last_run_state TEXT NOT NULL,
      last_safe_error_code TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES app_automations(id) ON DELETE CASCADE,
      target_session_id TEXT NOT NULL,
      state TEXT NOT NULL,
      trigger TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      safe_error_code TEXT,
      queued_message_id TEXT,
      turn_id TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS projects_active_workspace_path_idx
    ON projects(workspace_path)
    WHERE archived = 0;

    CREATE INDEX IF NOT EXISTS app_automations_target_idx
    ON app_automations(target_session_id, state);

    CREATE INDEX IF NOT EXISTS app_automation_runs_automation_idx
    ON app_automation_runs(automation_id);

    CREATE INDEX IF NOT EXISTS message_files_owner_idx
    ON message_files(owner_session_id, message_id);

    CREATE INDEX IF NOT EXISTS message_attachments_message_idx
    ON message_attachments(message_id, position);

    CREATE INDEX IF NOT EXISTS session_queued_messages_session_idx
    ON session_queued_messages(chat_id, state);

    CREATE INDEX IF NOT EXISTS turns_chat_state_idx
    ON turns(chat_id, state);

    CREATE INDEX IF NOT EXISTS app_turn_cancel_outbox_pending_idx
    ON app_turn_cancel_outbox(state, turn_id);

    CREATE INDEX IF NOT EXISTS events_type_id_idx
    ON events(type, id DESC);

    CREATE INDEX IF NOT EXISTS events_type_session_id_idx
    ON events(type, json_extract(payload_json, '$.session_id'), id DESC);

  `);
  if (turnsTableIsNew) {
    db.exec("CREATE INDEX turns_state_rowid_idx ON turns(state)");
  }
  if (eventsTableIsNew) {
    db.exec(`
      CREATE INDEX events_turn_id_idx ON events(turn_id, id DESC)
      WHERE turn_id <> ''
    `);
  }
  ensureTerminalRetentionSchema(db);
  ensureAppMessageQuerySchema(db);
  ensureColumn(db, "chats", "conversation_session_id", "TEXT");
  ensureColumn(db, "chats", "pinned", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "chats", "archived", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "messages", "turn_id", "TEXT");
  ensureColumn(db, "messages", "conversation_session_id", "TEXT");
  ensureColumn(db, "messages", "conversation_turn_id", "TEXT");
  ensureColumn(db, "messages", "conversation_message_id", "TEXT");
  ensureColumn(db, "messages", "updated_at", "TEXT");
  ensureColumn(db, "messages", "safe_error_code", "TEXT");
  ensureColumn(db, "messages", "retryable", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "message_changed_files", "detail_json", "TEXT");
  ensureColumn(db, "projects", "ledger_project_id", "TEXT");
  ensureColumn(db, "turns", "execution_controls_json", "TEXT");
  ensureColumn(db, "turns", "execution_model_json", "TEXT");
  ensureColumn(db, "session_queued_messages", "client_message_id", "TEXT");
  ensureColumn(db, "session_queued_messages", "input_identity_digest", "TEXT");
  ensureColumn(db, "session_queued_messages", "control_resolution_json", "TEXT");
  ensureColumn(db, "session_queued_messages", "claim_id", "TEXT");
  ensureColumn(db, "session_queued_messages", "claim_owner", "TEXT");
  ensureColumn(db, "session_queued_messages", "claimed_at", "TEXT");
  ensureColumn(db, "session_queued_messages", "lease_expires_at", "TEXT");
  ensureColumn(
    db,
    "session_queued_messages",
    "terminal_result_message_id",
    "TEXT",
  );
  ensureColumn(db, "events", "turn_id", "TEXT");
  ensureColumn(db, "app_conversation_projection_state", "last_outcome_id", "TEXT");
  ensureColumn(
    db,
    "app_transcript_projection_checkpoints",
    "boundary_anchor_text",
    "TEXT NOT NULL DEFAULT ''",
  );
  ensureColumn(db, "app_transcript_projection_checkpoints", "spool_path", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "app_transcript_projection_checkpoints", "spool_bytes", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "app_transcript_projection_checkpoints", "spool_end_offset", "INTEGER NOT NULL DEFAULT 0");
  backfillQueuedMessageIdentity(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_message_idx
    ON messages(conversation_message_id)
    WHERE conversation_message_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS messages_conversation_session_idx
    ON messages(conversation_session_id, conversation_turn_id);

    CREATE INDEX IF NOT EXISTS chats_conversation_session_idx
    ON chats(conversation_session_id);

    CREATE UNIQUE INDEX IF NOT EXISTS session_queued_messages_client_idx
    ON session_queued_messages(chat_id, client_message_id)
    WHERE client_message_id IS NOT NULL;

  `);
  db.query("UPDATE chats SET kind = 'chat' WHERE kind = 'general'").run();
  db.query("UPDATE messages SET updated_at = created_at WHERE updated_at IS NULL").run();
  initializeProjectLedgerBindings(db, options);
}

function backfillQueuedMessageIdentity(db: Database): void {
  const rows = db.query<{
    id: string;
    chat_id: string;
    text: string;
    client_message_id: string | null;
    input_identity_digest: string | null;
    control_resolution_json: string | null;
    controls_json: string;
    attachments_json: string;
  }, []>(`
    SELECT id, chat_id, text, client_message_id, input_identity_digest,
      control_resolution_json, controls_json, attachments_json
    FROM session_queued_messages
    WHERE client_message_id IS NULL
      OR input_identity_digest IS NULL
      OR control_resolution_json IS NULL
    ORDER BY rowid ASC
  `).all();
  for (const row of rows) {
    const clientMessageId = row.client_message_id ?? legacyQueuedClientMessageId(row.id);
    const digest = row.input_identity_digest ?? legacyQueuedInputIdentityDigest(db, row);
    const resolution = row.control_resolution_json ?? legacyQueuedControlResolution(row.controls_json);
    db.query(`
      UPDATE session_queued_messages
      SET client_message_id = COALESCE(client_message_id, ?),
        input_identity_digest = COALESCE(input_identity_digest, ?),
        control_resolution_json = COALESCE(control_resolution_json, ?)
      WHERE id = ?
    `).run(clientMessageId, digest, resolution, row.id);
  }
}

function legacyQueuedControlResolution(controlsJson: string): string | null {
  try {
    const controls = JSON.parse(controlsJson) as Record<string, unknown>;
    if (typeof controls.model !== "string" || !controls.model.includes("/")) return null;
    return JSON.stringify({
      controls: {
        model: controls.model,
        reasoning_effort: controls.reasoning_effort ?? "none",
        access_mode: controls.access_mode ?? "full_access",
        plan_mode: controls.plan_mode === true,
      },
      source: "session_override",
      sessionControlRevision: 0,
      catalogGeneration: "legacy",
    });
  } catch {
    return null;
  }
}

function legacyQueuedClientMessageId(queuedId: string): string {
  const digest = createHash("sha256").update(`legacy-client:${queuedId}`).digest("hex").slice(0, 32);
  return `client-${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
}

function legacyQueuedInputIdentityDigest(db: Database, row: {
  id: string;
  chat_id: string;
  text: string;
  controls_json: string;
  attachments_json: string;
}): string {
  let controls: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.controls_json) as unknown;
    if (parsed && typeof parsed === "object") controls = parsed as Record<string, unknown>;
  } catch {
    // Keep the durable legacy payload bound even when controls were malformed.
  }
  let attachments: unknown[] = [];
  try {
    const parsed = JSON.parse(row.attachments_json) as unknown;
    if (Array.isArray(parsed)) attachments = parsed;
  } catch {
    // An invalid legacy attachment payload remains bound to an empty safe identity.
  }
  const admissionIdentity = attachments.map((attachment) => {
    const fileId = typeof attachment === "string"
      ? attachment
      : attachment && typeof attachment === "object" &&
          typeof (attachment as { file_id?: unknown }).file_id === "string"
        ? (attachment as { file_id: string }).file_id
        : "";
    const file = fileId
      ? db.query<{
        id: string;
        kind: string;
        mime_type: string;
        safe_name: string;
        size_bytes: number;
        sha256: string;
      }, [string]>(`
        SELECT id, kind, mime_type, safe_name, size_bytes, sha256
        FROM message_files
        WHERE id = ?
      `).get(fileId)
      : undefined;
    return file ?? { id: fileId };
  });
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    text: row.text.trim(),
    explicit_controls: {
      model: controls.model ?? null,
      reasoning_effort: controls.reasoning_effort ?? null,
      access_mode: controls.access_mode ?? null,
      plan_mode: controls.plan_mode ?? null,
    },
    admission_identity: admissionIdentity,
  })).digest("hex");
}

export function seedAppStoreDefaults(db: Database): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO chats (id, title, kind, project_id, pinned, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?)
  `).run(DEFAULT_CHAT_ID, DEFAULT_CHAT_TITLE, "chat", null, now, now);
  db
    .query(
      `
      UPDATE chats
      SET title = ?, updated_at = ?
      WHERE id = ?
        AND title = 'New chat'
        AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.chat_id = chats.id)
    `,
    )
    .run(DEFAULT_CHAT_TITLE, now, DEFAULT_CHAT_ID);
  removeUnusedSeededButlerProject(db);
}

function removeUnusedSeededButlerProject(db: Database): void {
  db
    .query(
      `
      DELETE FROM chats
      WHERE id = 'project-butler'
        AND kind = 'project'
        AND project_id = ?
        AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.chat_id = chats.id)
    `,
    )
    .run(DEFAULT_PROJECT_ID);
  db
    .query(
      `
      DELETE FROM projects
      WHERE id = ?
        AND display_name = 'butler'
        AND NOT EXISTS (SELECT 1 FROM chats WHERE chats.project_id = projects.id)
    `,
    )
    .run(DEFAULT_PROJECT_ID);
}
