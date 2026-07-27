export const BTCC_TERMINAL_SETTLEMENT_WAKE_SCHEMA = `
CREATE TABLE IF NOT EXISTS btcc_terminal_settlement_wakes (
  turn_id TEXT PRIMARY KEY,
  semantic_state TEXT NOT NULL,
  settled_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS btcc_terminal_settlement_wake_on_insert
AFTER INSERT ON btcc_turns
WHEN NEW.semantic_state IN ('delivered', 'cancelled')
BEGIN
  INSERT OR IGNORE INTO btcc_terminal_settlement_wakes (
    turn_id, semantic_state, settled_at
  ) VALUES (NEW.turn_id, NEW.semantic_state, datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS btcc_terminal_settlement_wake_on_update
AFTER UPDATE OF semantic_state ON btcc_turns
WHEN NEW.semantic_state IN ('delivered', 'cancelled')
  AND OLD.semantic_state NOT IN ('delivered', 'cancelled')
BEGIN
  INSERT OR IGNORE INTO btcc_terminal_settlement_wakes (
    turn_id, semantic_state, settled_at
  ) VALUES (NEW.turn_id, NEW.semantic_state, datetime('now'));
END;
`;
