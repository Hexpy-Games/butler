//! A verified copy and its rollback share logical findings, never a corrupt marker.
use super::*;

#[tokio::test]
async fn correction_rollback_preserves_findings_without_startup_scan() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = effects().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    Connection::open(&path)?.execute_batch(
        "UPDATE btcc_guided_effects SET plan_revision_id='missing';
        PRAGMA secure_delete=OFF;
        INSERT INTO btcc_records(record_id,kind,sha256,content_json) VALUES('compact-space','fixture','fixture',zeroblob(40000000));
        DELETE FROM btcc_records WHERE record_id='compact-space';
        UPDATE agent_storage_corrections SET state='reclaimed';
        PRAGMA wal_checkpoint(TRUNCATE);",
    )?;
    let before = snapshot(&path)?;
    let original = butler_platform::secure_fs::identity(&std::fs::metadata(&path)?).id;
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_e2e-storage-rollback"))
        .arg(&path)
        .output()
        .await?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        butler_platform::secure_fs::identity(&std::fs::metadata(&path)?).id,
        original
    );
    assert_eq!(snapshot(&path)?, before);
    assert_findings(&path)?;
    assert!(!path.with_extension("sqlite.corrupt").exists());
    let state: String = Connection::open(&path)?.query_row(
        "SELECT state FROM agent_storage_corrections",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(state, "failed_open");
    s.gw = s.agent.start_again().await?;
    assert!(s.gw.healthy().await);
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-2.log"))?;
    assert!(!log.contains("phase=full_validation_begin"), "{log}");
    assert!(!log.contains("phase=reference_"), "{log}");
    assert_findings(&path)?;
    s.finish().await
}
