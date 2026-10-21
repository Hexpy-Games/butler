//! Query-plan evidence accompanies the real-process timing/content regression.
use super::*;

const OLD_DRAIN: &str = "UPDATE btcc_model_round_acceptances SET normalized_response_json='{}',continuation_delta_json=NULL,payload_state=2 WHERE turn_id IN (SELECT c.turn_id FROM chunk c JOIN btcc_turns t ON t.turn_id=c.turn_id WHERE t.semantic_state <> 'admitted')";
const DRAIN: &str = "UPDATE btcc_model_round_acceptances SET normalized_response_json='{}',continuation_delta_json=NULL,payload_state=2 WHERE turn_id IN (SELECT c.turn_id FROM chunk c WHERE EXISTS (SELECT 1 FROM btcc_turns t WHERE t.turn_id=c.turn_id AND t.semantic_state <> 'admitted'))";
const BACKFILL: &str = "SELECT DISTINCT a.turn_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM btcc_model_round_acceptances a JOIN btcc_turns t ON t.turn_id=a.turn_id WHERE t.semantic_state <> 'admitted'";

pub(super) fn check(path: &Path) -> Result<(), HarnessError> {
    let db = Connection::open(path)?;
    db.execute_batch("CREATE TEMP TABLE chunk(turn_id TEXT PRIMARY KEY); INSERT INTO chunk VALUES('history-000000')")?;
    for (name, sql, indexed) in [
        ("before-drain", OLD_DRAIN, false),
        ("after-drain", DRAIN, true),
        ("unchanged-backfill", BACKFILL, true),
        (
            "queued-count",
            "SELECT count(*) FROM agent_acceptance_reclaims",
            true,
        ),
        (
            "queued-exists",
            "SELECT EXISTS(SELECT 1 FROM agent_acceptance_reclaims)",
            true,
        ),
    ] {
        let plan = db
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?
            .query_map([], |r| r.get::<_, String>(3))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        eprintln!("RECLAIM-PLAN {name}: {plan:?}");
        if indexed {
            assert!(
                !plan
                    .iter()
                    .any(|line| line.starts_with("SCAN t") || line.contains("SCAN btcc_turns")),
                "{name}: {plan:?}"
            );
        }
    }
    Ok(())
}
