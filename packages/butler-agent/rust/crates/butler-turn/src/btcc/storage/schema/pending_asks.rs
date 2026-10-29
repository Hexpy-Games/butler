//! Indexed read projection invalidations; authority remains the owner.
pub(in crate::btcc::storage) const SCHEMA: &str = r"
CREATE INDEX IF NOT EXISTS idx_btcc_questions_settled ON btcc_authority_requests(owner_session_id,updated_at)
WHERE capability='ask_user' AND outcome_receipt_json IS NOT NULL;
DROP INDEX IF EXISTS idx_btcc_authority_open;
CREATE INDEX IF NOT EXISTS idx_btcc_authority_open_v2 ON btcc_authority_requests(created_at)
WHERE close_reason IS NULL AND (decision='pending' OR
 (capability='ask_user' AND decision='modified' AND outcome_receipt_json IS NULL AND json_extract(CASE WHEN capability='ask_user' THEN private_alternative_input END,'$.status')='deferred'));
-- The suspension trigger seeks this turn only; the deployed indexes start with
-- owner_session_id or source_work_id and cannot bound a source_turn_id lookup.
CREATE INDEX IF NOT EXISTS idx_btcc_authority_pending_turn ON btcc_authority_requests(source_turn_id)
WHERE decision='pending' AND close_reason IS NULL;
CREATE TABLE IF NOT EXISTS agent_pending_ask_changes (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
 request_ref TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS pending_ask_insert AFTER INSERT ON btcc_authority_requests
WHEN NEW.capability='ask_user' AND NEW.decision='modified'
 AND NEW.outcome_receipt_json IS NULL AND NEW.close_reason IS NULL BEGIN
 INSERT INTO agent_pending_ask_changes(owner,request_ref,kind,state)
 VALUES(NEW.owner_session_id,NEW.request_ref,'question','open');
END;
CREATE TRIGGER IF NOT EXISTS pending_ask_update AFTER UPDATE ON btcc_authority_requests
WHEN (OLD.decision='pending' AND NEW.decision<>'pending')
 OR (OLD.close_reason IS NULL AND NEW.close_reason IS NOT NULL)
 OR (OLD.capability='ask_user' AND OLD.outcome_receipt_json IS NULL AND NEW.outcome_receipt_json IS NOT NULL)
BEGIN
 INSERT INTO agent_pending_ask_changes(owner,request_ref,kind,state)
 VALUES(NEW.owner_session_id,NEW.request_ref,
 CASE WHEN NEW.capability='ask_user' THEN 'question' ELSE 'approval' END,
 CASE WHEN NEW.close_reason IS NOT NULL THEN 'closed'
 WHEN NEW.capability='ask_user' AND json_extract(NEW.outcome_receipt_json,'$.status') IN ('dismissed','resolved_in_chat','closed')
 THEN json_extract(NEW.outcome_receipt_json,'$.status')
 WHEN NEW.capability='ask_user' AND NEW.decision='modified' AND NEW.outcome_receipt_json IS NULL
 AND json_extract(NEW.private_alternative_input,'$.status')='deferred' THEN 'open'
 ELSE 'answered' END);
END;
CREATE TRIGGER IF NOT EXISTS pending_ask_suspended AFTER UPDATE OF suspension_reason ON btcc_turns
WHEN NEW.suspension_reason='authority_pending' AND OLD.suspension_reason IS NOT NEW.suspension_reason
BEGIN
 INSERT INTO agent_pending_ask_changes(owner,request_ref,kind,state)
 SELECT owner_session_id,request_ref,CASE WHEN capability='ask_user' THEN 'question' ELSE 'approval' END,'open'
 FROM btcc_authority_requests INDEXED BY idx_btcc_authority_pending_turn WHERE source_turn_id=NEW.turn_id
 AND decision='pending' AND close_reason IS NULL;
END;
";
