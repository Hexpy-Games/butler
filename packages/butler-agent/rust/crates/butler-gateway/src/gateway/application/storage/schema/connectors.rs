use super::super::AppStorageError;
use rusqlite::Connection;
pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS app_connector_events(
        event_id TEXT PRIMARY KEY, connector TEXT NOT NULL, account TEXT NOT NULL,
        dedupe_key TEXT NOT NULL, arrived_at TEXT NOT NULL, received_at INTEGER NOT NULL, data_json TEXT NOT NULL,
        matched_rules TEXT NOT NULL DEFAULT '[]', actions_json TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]', lane TEXT, ready INTEGER NOT NULL DEFAULT 0,
        skip_model INTEGER NOT NULL DEFAULT 0, skip_rules TEXT NOT NULL DEFAULT '[]', delivered_at TEXT, digested_at TEXT,
        delivery_id TEXT, UNIQUE(connector,account,dedupe_key));
        DROP INDEX IF EXISTS connector_retention;
        CREATE INDEX IF NOT EXISTS connector_arrival_retention ON app_connector_events(arrived_at) WHERE delivered_at IS NOT NULL OR digested_at IS NOT NULL;
        CREATE TABLE IF NOT EXISTS app_connector_cursors(account TEXT PRIMARY KEY, cursor TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS connector_event_delivery ON app_connector_events(delivery_id);
        CREATE INDEX IF NOT EXISTS connector_pending ON app_connector_events(account,ready,delivered_at,digested_at);
        CREATE INDEX IF NOT EXISTS connector_lane ON app_connector_events(lane,received_at);
        CREATE TABLE IF NOT EXISTS app_connector_signals(
        connector TEXT NOT NULL, account TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        received_at INTEGER NOT NULL, PRIMARY KEY(connector,account,dedupe_key));
        CREATE INDEX IF NOT EXISTS connector_signal_retention ON app_connector_signals(received_at);
        CREATE TABLE IF NOT EXISTS app_connector_rules(
        id TEXT PRIMARY KEY, connector TEXT NOT NULL, account TEXT, rule_json TEXT NOT NULL,
        match_count INTEGER NOT NULL DEFAULT 0, signals INTEGER NOT NULL DEFAULT 0,
        signal_times TEXT NOT NULL DEFAULT '[]', announced_at TEXT);
        CREATE INDEX IF NOT EXISTS connector_rules_scope ON app_connector_rules(connector,account);
        CREATE TABLE IF NOT EXISTS app_connector_deliveries(
        id TEXT PRIMARY KEY, account TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, admitted_at TEXT);
        CREATE INDEX IF NOT EXISTS connector_delivery_retention ON app_connector_deliveries(created_at);
        CREATE INDEX IF NOT EXISTS connector_delivery_pending ON app_connector_deliveries(account,admitted_at);")
        .map_err(AppStorageError::sqlite)
}
