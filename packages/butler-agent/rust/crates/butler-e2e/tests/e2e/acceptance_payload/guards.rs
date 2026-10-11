//! Corrupted immutable-chain fixtures must fail with the single delta wire code.
use super::{process::Process, rows};
use butler_e2e::e2e::{HarnessError, sandbox::Sandbox};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

pub(super) async fn verify(sandbox: &Sandbox, endpoint: &str) -> Result<(), HarnessError> {
    let path = sandbox.data.join("round-store.sqlite");
    Connection::open(&path)?.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    let baseline = sandbox.root.join("guard-baseline.sqlite");
    std::fs::copy(&path, &baseline)?;
    let original = rows(&path, "turn")?;
    for case in [
        "turn",
        "checkpoint",
        "revision",
        "reclaimed",
        "missing",
        "baseCount",
        "count",
        "range",
        "version",
        "cycle",
        "null",
    ] {
        restore(&path, &baseline)?;
        let db = Connection::open(&path)?;
        let first = &original[0].0;
        let last = &original[5].0;
        let mut delta: Value = serde_json::from_str(original[5].3.as_ref().unwrap())?;
        match case {
            "turn" => {
                db.execute("UPDATE btcc_model_round_acceptances SET turn_id='foreign' WHERE acceptance_id=?1", [first])?;
            }
            "checkpoint" => {
                db.execute("UPDATE btcc_model_round_acceptances SET checkpoint_id='foreign' WHERE acceptance_id=?1", [first])?;
            }
            "revision" => {
                db.execute("UPDATE btcc_model_round_acceptances SET checkpoint_revision=checkpoint_revision+1 WHERE acceptance_id=?1", [first])?;
            }
            "reclaimed" => {
                db.execute("UPDATE btcc_model_round_acceptances SET payload_state=2 WHERE acceptance_id=?1", [first])?;
            }
            "missing" => delta["base"] = json!("missing"),
            "baseCount" => delta["baseCount"] = json!(delta["baseCount"].as_u64().unwrap() + 1),
            "count" => delta["count"] = json!(delta["count"].as_u64().unwrap() + 1),
            "range" => delta["ops"][0] = json!({"c":[1,1]}),
            "version" => delta["v"] = json!(2),
            "cycle" => delta["base"] = json!(last),
            "null" => {}
            _ => return Err(butler_e2e::e2e::harness_error("unknown guard fixture")),
        }
        if matches!(
            case,
            "missing" | "baseCount" | "count" | "range" | "version" | "cycle" | "null"
        ) {
            let raw = (case != "null").then(|| delta.to_string());
            db.execute("UPDATE btcc_model_round_acceptances SET continuation_delta_json=?1 WHERE acceptance_id=?2", params![raw,last])?;
        }
        drop(db);
        let status = Process::start(sandbox, endpoint, 6, "latest")?
            .exit()
            .await?;
        assert!(!status.success(), "invalid chain accepted: {case}");
        let log = std::fs::read_to_string(sandbox.logs.join("latest.log"))?;
        assert!(
            log.contains("model_acceptance_delta_invalid"),
            "wrong guard code: {case}"
        );
    }
    restore(&path, &baseline)?;
    Ok(())
}
fn restore(path: &std::path::Path, baseline: &std::path::Path) -> Result<(), HarnessError> {
    for suffix in ["sqlite-wal", "sqlite-shm"] {
        let _ = std::fs::remove_file(path.with_extension(suffix));
    }
    std::fs::copy(baseline, path)?;
    Ok(())
}
