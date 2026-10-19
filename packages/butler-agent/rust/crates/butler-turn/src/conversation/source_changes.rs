//! The source change log: an append-only sequence of the turns and messages
//! whose recall-relevant facts changed, written by store triggers inside the
//! writer's own transaction (any writer, including foreign-key cascades).
//!
//! Only facts a recall source is built from are logged: a turn once it has
//! an outcome (its outcome, status and identity), a message that is
//! standalone or belongs to a turn with an outcome (its identity, session,
//! role, status, origin, provenance, time and parts). A turn's own messages
//! written before its outcome are covered by the outcome's change. Rows are
//! appended, never rewritten; every 4,096th change drops the changes more
//! than 65,536 behind, so a reader whose watermark row is gone starts over.
//! Each row carries a random token: a store restored from an older copy
//! that logs the same entity at the same sequence again is still told apart.

pub(super) const SQL: &str = r"
CREATE TABLE IF NOT EXISTS conversation_source_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  token TEXT NOT NULL DEFAULT (lower(hex(randomblob(8))))
);
CREATE TRIGGER IF NOT EXISTS conversation_source_changes_window
AFTER INSERT ON conversation_source_changes WHEN NEW.seq % 4096 = 0 BEGIN
  DELETE FROM conversation_source_changes WHERE seq <= NEW.seq - 65536;
END;
CREATE TRIGGER IF NOT EXISTS conversation_turns_source_change_insert
AFTER INSERT ON conversation_turns
WHEN EXISTS (SELECT 1 FROM conversation_turn_outcomes o WHERE o.turn_id = NEW.id) BEGIN
  INSERT INTO conversation_source_changes(kind, entity_id) VALUES ('turn', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS conversation_turns_source_change_update
AFTER UPDATE OF id, session_id, status ON conversation_turns
WHEN (OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.status IS NOT NEW.status)
  AND EXISTS (SELECT 1 FROM conversation_turn_outcomes o WHERE o.turn_id IN (OLD.id, NEW.id)) BEGIN
  INSERT INTO conversation_source_changes(kind, entity_id) VALUES ('turn', NEW.id);
  INSERT INTO conversation_source_changes(kind, entity_id) SELECT 'turn', OLD.id WHERE OLD.id IS NOT NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS conversation_turns_source_change_delete
AFTER DELETE ON conversation_turns BEGIN
  INSERT INTO conversation_source_changes(kind, entity_id) VALUES ('turn', OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS conversation_turn_outcomes_source_change_insert
AFTER INSERT ON conversation_turn_outcomes BEGIN
  INSERT INTO conversation_source_changes(kind, entity_id) VALUES ('turn', NEW.turn_id);
END;
CREATE TRIGGER IF NOT EXISTS conversation_turn_outcomes_source_change_update
AFTER UPDATE ON conversation_turn_outcomes BEGIN
  INSERT INTO conversation_source_changes(kind, entity_id) VALUES ('turn', NEW.turn_id);
  INSERT INTO conversation_source_changes(kind, entity_id) SELECT 'turn', OLD.turn_id WHERE OLD.turn_id IS NOT NEW.turn_id;
END;
CREATE TRIGGER IF NOT EXISTS conversation_turn_outcomes_source_change_delete
AFTER DELETE ON conversation_turn_outcomes BEGIN
  INSERT INTO conversation_source_changes(kind, entity_id) VALUES ('turn', OLD.turn_id);
END;
CREATE TRIGGER IF NOT EXISTS conversation_messages_source_change_insert
AFTER INSERT ON conversation_messages
WHEN NEW.turn_id IS NULL
  OR EXISTS (SELECT 1 FROM conversation_turn_outcomes o WHERE o.turn_id = NEW.turn_id) BEGIN
  INSERT INTO conversation_source_changes(kind, entity_id) VALUES ('message', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS conversation_messages_source_change_update
AFTER UPDATE OF id, session_id, turn_id, role, status, origin_kind, provenance, created_at
ON conversation_messages
WHEN OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.turn_id IS NOT NEW.turn_id
  OR OLD.role IS NOT NEW.role OR OLD.status IS NOT NEW.status OR OLD.origin_kind IS NOT NEW.origin_kind
  OR OLD.provenance IS NOT NEW.provenance OR OLD.created_at IS NOT NEW.created_at BEGIN
  INSERT INTO conversation_source_changes(kind, entity_id) VALUES ('message', NEW.id);
  INSERT INTO conversation_source_changes(kind, entity_id) SELECT 'message', OLD.id WHERE OLD.id IS NOT NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS conversation_messages_source_change_delete
AFTER DELETE ON conversation_messages BEGIN
  INSERT INTO conversation_source_changes(kind, entity_id) VALUES ('message', OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS conversation_parts_source_change_insert
AFTER INSERT ON conversation_parts
WHEN EXISTS (SELECT 1 FROM conversation_messages m WHERE m.id = NEW.message_id AND (m.turn_id IS NULL
  OR EXISTS (SELECT 1 FROM conversation_turn_outcomes o WHERE o.turn_id = m.turn_id))) BEGIN
  INSERT INTO conversation_source_changes(kind, entity_id) VALUES ('message', NEW.message_id);
END;
CREATE TRIGGER IF NOT EXISTS conversation_parts_source_change_update
AFTER UPDATE ON conversation_parts BEGIN
  INSERT INTO conversation_source_changes(kind, entity_id) VALUES ('message', NEW.message_id);
  INSERT INTO conversation_source_changes(kind, entity_id) SELECT 'message', OLD.message_id WHERE OLD.message_id IS NOT NEW.message_id;
END;
CREATE TRIGGER IF NOT EXISTS conversation_parts_source_change_delete
AFTER DELETE ON conversation_parts
WHEN EXISTS (SELECT 1 FROM conversation_messages m WHERE m.id = OLD.message_id) BEGIN
  INSERT INTO conversation_source_changes(kind, entity_id) VALUES ('message', OLD.message_id);
END;
";
