//! Real effect writer, deferred scan, startup recheck and correction policy.
mod project;
mod rollback;
mod stub;
use butler_e2e::e2e::{
    HarnessError, fixtures,
    gateway::turn_state,
    scenario::{Access, Scenario, Setup},
};
use rusqlite::Connection;
use std::{
    path::Path,
    time::{Duration, Instant},
};

async fn effects() -> Result<Scenario, HarnessError> {
    let setup = Setup::new("BTCC-PLANLESS-EFFECTS")?.access(Access::FullAccess);
    let file = setup.sandbox.workspace.join("integrity.txt");
    let (url, server) = stub::start(file.display().to_string(), false, true).await?;
    fixtures::stub_codex_auth(&setup.sandbox.codex_home())?;
    let s = setup
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_STARTUP_TRACE", "1")
        .start()
        .await?;
    let result = s.turn("general", stub::REQUEST).await;
    server.abort();
    let (_, turn) = result?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(std::fs::read_to_string(file)?, "beta");
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let count: i64 = db.query_row("SELECT COUNT(*) FROM btcc_guided_effects e JOIN btcc_guided_works w ON w.work_id=e.work_id WHERE e.plan_revision_id='' AND e.status='applied' AND w.scope_kind='session' AND w.current_plan_revision_id IS NULL", [], |r| r.get(0))?;
    assert_eq!(count, 2);
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM btcc_guided_work_plan_revisions",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM btcc_guided_effect_recovery_hints",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        1
    );
    Ok(s)
}

pub(super) async fn wait_scan(s: &Scenario, path: &Path) -> Result<(), HarnessError> {
    let started = Instant::now();
    while !path.with_extension("sqlite.verified").exists()
        && started.elapsed() < Duration::from_secs(10)
    {
        assert!(s.gw.healthy().await);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        path.with_extension("sqlite.verified").exists(),
        "scan did not complete"
    );
    Ok(())
}

fn snapshot(path: &Path) -> Result<Vec<String>, HarnessError> {
    let db = Connection::open(path)?;
    let mut rows = Vec::new();
    for table in [
        "btcc_guided_effects",
        "btcc_guided_effect_recovery_hints",
        "btcc_guided_effect_recovery_payloads",
    ] {
        let mut query = db.prepare(&format!("SELECT * FROM {table} ORDER BY effect_id"))?;
        let columns = query.column_count();
        rows.extend(
            query
                .query_map([], |row| {
                    Ok((0..columns)
                        .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                        .collect::<Vec<_>>()
                        .join("|"))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );
    }
    Ok(rows)
}

#[tokio::test]
async fn session_effects_without_plan_pass_scan_and_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = effects().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let before = snapshot(&path)?;
    std::fs::remove_file(path.with_extension("sqlite.verified"))?;
    s.gw = s.agent.start_again().await?;
    wait_scan(&s, &path).await?;
    assert!(!path.with_extension("sqlite.corrupt").exists());
    assert!(!path.with_extension("sqlite.findings").exists());
    s.agent.terminate().await?;
    // The owner's legacy code-only verdict must also clear.
    std::fs::write(
        path.with_extension("sqlite.corrupt"),
        "agent_btcc_migration_reference_check_failed",
    )?;
    s.gw = s.agent.start_again().await?;
    assert!(s.gw.healthy().await);
    assert!(!path.with_extension("sqlite.corrupt").exists());
    assert!(!path.with_extension("sqlite.findings").exists());
    assert_eq!(snapshot(&path)?, before);
    explain(&path)?;
    s.finish().await
}

fn explain(path: &Path) -> Result<(), HarnessError> {
    let db = Connection::open(path)?;
    let mut query = db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM btcc_guided_effects AS source LEFT JOIN btcc_guided_work_plan_revisions AS target ON target.plan_revision_id=source.plan_revision_id AND target.work_id=source.work_id WHERE source.plan_revision_id IS NOT NULL AND source.plan_revision_id<>'' AND NOT EXISTS (SELECT 1 FROM btcc_guided_works AS work WHERE work.work_id=source.work_id AND work.scope_kind='project') AND target.plan_revision_id IS NULL")?;
    for row in query.query_map([], |r| r.get::<_, String>(3))? {
        eprintln!("effect_plan query plan: {}", row?);
    }
    Ok(())
}

#[tokio::test]
async fn orphan_effect_plan_warns_preserves_rows_and_compacts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = effects().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    Connection::open(&path)?.execute(
        "UPDATE btcc_guided_effects SET plan_revision_id='missing'",
        [],
    )?;
    let before = snapshot(&path)?;
    crate::btcc_corrupt_startup::write_verdict(&path, true)?;
    s.gw = s.agent.start_again().await?;
    assert_warning(&s, &path, 2)?;
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-2.log"))?;
    assert_eq!(
        log.matches("phase=full_validation_begin").count(),
        1,
        "{log}"
    );
    assert_eq!(
        log.matches("phase=reference_effect_plan_begin").count(),
        1,
        "{log}"
    );
    assert!(!path.with_extension("sqlite.corrupt").exists());
    for generation in 3..=4 {
        s.agent.terminate().await?;
        s.gw = s.agent.start_again().await?;
        assert!(s.gw.healthy().await);
        let log = std::fs::read_to_string(s.sandbox.logs.join(format!("agent-{generation}.log")))?;
        assert!(!log.contains("phase=full_validation_begin"), "{log}");
        assert!(!log.contains("phase=reference_"), "{log}");
        assert!(!path.with_extension("sqlite.corrupt").exists());
    }
    s.agent.terminate().await?;
    // Force the real offline-copy verification path after the startup recheck.
    Connection::open(&path)?.execute_batch(
        "PRAGMA secure_delete=OFF;
        INSERT INTO btcc_records(record_id,kind,sha256,content_json) VALUES('compact-space','fixture','fixture',zeroblob(40000000));
        DELETE FROM btcc_records WHERE record_id='compact-space';
        UPDATE agent_storage_corrections SET state='reclaimed';
        PRAGMA wal_checkpoint(TRUNCATE);",
    )?;
    s.gw = s.agent.start_again().await?;
    assert!(s.gw.healthy().await);
    assert_warning(&s, &path, 5)?;
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-5.log"))?;
    assert!(
        log.contains("outcome=compacted"),
        "copy verification was not exercised: {log}"
    );
    let state: String = Connection::open(&path)?.query_row(
        "SELECT state FROM agent_storage_corrections",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(state, "done", "logical findings must not defer correction");
    assert_eq!(snapshot(&path)?, before);
    let stamp = std::fs::read(path.with_extension("sqlite.verified"))?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        std::fs::read(path.with_extension("sqlite.verified"))?,
        stamp,
        "no scan retry loop"
    );
    s.finish().await
}

fn assert_warning(s: &Scenario, path: &Path, generation: u32) -> Result<(), HarnessError> {
    assert_findings(path)?;
    let log = std::fs::read_to_string(s.sandbox.logs.join(format!("agent-{generation}.log")))?;
    assert!(
        log.contains(
            "warning agent_btcc_migration_reference_check_failed rule=effect_plan orphan_count=2"
        ),
        "{log}"
    );
    assert!(!log.contains("storage_bootstrap_failed"), "{log}");
    Ok(())
}

#[tokio::test]
async fn effect_plan_requires_same_work_for_btcc_plans() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = effects().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    db.execute_batch("INSERT INTO btcc_guided_works(work_id,session_id,scope_kind,scope_ref,origin_turn_id,origin_message_id,objective,status,created_at,updated_at)
        SELECT 'other',session_id,'session',scope_ref,origin_turn_id,origin_message_id,objective,'completed',created_at,updated_at FROM btcc_guided_works LIMIT 1;
        INSERT INTO btcc_guided_work_plan_revisions(plan_revision_id,work_id,revision,objective,governing_refs_json,actions_json,checks_json,origin_turn_id,created_at)
        SELECT 'foreign','other',1,'other','[]','[]','[]',origin_turn_id,created_at FROM btcc_guided_works WHERE work_id='other';
        INSERT INTO btcc_guided_work_plan_revisions(plan_revision_id,work_id,revision,objective,governing_refs_json,actions_json,checks_json,origin_turn_id,created_at)
        SELECT 'own',work_id,1,objective,'[]','[]','[]',origin_turn_id,created_at FROM btcc_guided_works WHERE work_id!='other';")?;
    drop(db);
    for plan in ["", "own", "foreign"] {
        let db = Connection::open(&path)?;
        db.execute("UPDATE btcc_guided_effects SET plan_revision_id=?1", [plan])?;
        drop(db);
        let before = snapshot(&path)?;
        crate::btcc_corrupt_startup::write_verdict(&path, true)?;
        s.gw = s.agent.start_again().await?;
        assert!(s.gw.healthy().await);
        assert!(!path.with_extension("sqlite.corrupt").exists());
        if plan == "foreign" {
            assert_findings(&path)?;
        } else {
            assert!(!path.with_extension("sqlite.findings").exists(), "{plan}");
        }
        assert_eq!(snapshot(&path)?, before);
        s.agent.terminate().await?;
    }
    s.sandbox.mark_success();
    Ok(())
}

fn assert_findings(path: &Path) -> Result<(), HarnessError> {
    let findings = std::fs::read_to_string(path.with_extension("sqlite.findings"))?;
    assert!(
        findings.contains("rule=effect_plan orphan_count=2"),
        "{findings}"
    );
    let stamp = findings
        .lines()
        .find_map(|line| line.strip_prefix("checked_at="))
        .expect("findings timestamp");
    assert!(
        chrono::DateTime::parse_from_rfc3339(stamp).is_ok(),
        "{findings}"
    );
    Ok(())
}
