use rusqlite::Connection;

use super::super::AppStorageError;

pub(super) fn create(connection: &Connection) -> Result<(), AppStorageError> {
    connection
        .execute_batch(CORE_SCHEMA)
        .map_err(AppStorageError::sqlite)
}

const CORE_SCHEMA: &str = r"
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

    CREATE TABLE IF NOT EXISTS project_dashboard_briefing_cache (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      binding_revision TEXT,
      source_digest TEXT NOT NULL,
      response_language TEXT NOT NULL,
      generator_version TEXT NOT NULL,
      content_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, response_language)
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
      retryable INTEGER NOT NULL DEFAULT 0,
      plan_json TEXT
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

";
