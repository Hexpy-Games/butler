//! Only indexed pending evidence is reconciled at process startup.
use super::super::AppStorageError;
use rusqlite::Connection;
pub(super) fn recover(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS browser_still_deliveries (
        act_id TEXT NOT NULL, step INTEGER NOT NULL,
        session_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        tab_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        file_id TEXT REFERENCES message_files(id) ON DELETE SET NULL, reason TEXT,
        PRIMARY KEY(act_id,step));
        CREATE INDEX IF NOT EXISTS browser_still_pending_idx
        ON browser_still_deliveries(state) WHERE state='pending';
        CREATE INDEX IF NOT EXISTS browser_still_session_idx ON browser_still_deliveries(session_id);
        CREATE INDEX IF NOT EXISTS browser_still_file_idx ON browser_still_deliveries(file_id) WHERE file_id IS NOT NULL;
        UPDATE browser_still_deliveries SET state='pending',reason='gateway_restarted'
        WHERE state='pending' OR (state='failed' AND reason IN ('gateway_restarted','browser_host_restarted'));
        CREATE TRIGGER IF NOT EXISTS browser_still_file_deleted BEFORE DELETE ON message_files
        BEGIN
          UPDATE browser_still_deliveries SET state='failed',reason='file_deleted',file_id=NULL
          WHERE file_id=OLD.id;
        END;
        UPDATE browser_still_deliveries SET state='failed',reason='file_deleted'
        WHERE state='attached' AND file_id IS NULL;").map_err(AppStorageError::sqlite)
}
