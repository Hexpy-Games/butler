//! Repeated complete public reads include the cold sample and verify fresh revocation.
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};
use std::time::Duration;

pub(super) async fn measure_current(
    s: &Scenario,
    expected: &[Value],
    cold_us: u64,
) -> Result<(), HarnessError> {
    let mut samples = vec![cold_us];
    for _ in 1..100 {
        let listed = s.gw.get("/authority-permissions").await?;
        assert_eq!(listed.status, 200);
        assert_eq!(listed.data()["permissions"].as_array().unwrap(), expected);
        let timing = listed.dispatch_timing.as_ref().unwrap();
        samples.push(timing.split_once(',').unwrap().1.parse::<u64>().unwrap());
    }
    samples.sort_unstable();
    eprintln!("approvals-distribution server_us {samples:?}");
    let bytes = std::fs::metadata(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?.len();
    eprintln!(
        "approvals samples=100 btcc_bytes={bytes} p50_us={} p95_us={} p99_us={} max_us={}",
        samples[49], samples[94], samples[98], samples[99]
    );
    super::profile::report(&s.agent.logs());
    butler_e2e::assert_wall_clock_budget!(
        Duration::from_micros(samples[98]),
        Duration::from_millis(50),
        "all approvals p99: 3000 grants / 600 owners"
    );
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute(
        "UPDATE chats SET title='Renamed latest' WHERE id='chat-0'",
        [],
    )?;
    drop(db);
    let mut remaining = expected[1..].to_vec();
    for grant in &mut remaining {
        if grant["session_id"] == "butler/app-chat-0" {
            grant["session_title"] = json!("Renamed latest");
        }
    }
    let first = &expected[0];
    let revoked =
        s.gw.post(
            "/authority-permissions/revoke",
            json!({"grants":[{
                "session_id":first["session_id"], "grant_ref":first["grant_ref"]
            }]}),
        )
        .await?;
    assert_eq!(revoked.status, 200);
    let current = s.gw.get("/authority-permissions").await?;
    assert_eq!(current.status, 200);
    assert_eq!(
        current.data()["permissions"].as_array().unwrap(),
        &remaining
    );
    report_idle_writes(s).await?;
    Ok(())
}

async fn report_idle_writes(s: &Scenario) -> Result<(), HarnessError> {
    if std::env::var("BUTLER_E2E_PERF").as_deref() != Ok("1") {
        return Ok(());
    }
    let pid = s.agent.pid().unwrap();
    let before = butler_platform::process_control::sample_usage(pid)?.unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    let after = butler_platform::process_control::sample_usage(pid)?.unwrap();
    eprintln!(
        "approvals-idle seconds=3 write_bytes={}",
        after.write_bytes.saturating_sub(before.write_bytes)
    );
    Ok(())
}

#[tokio::test]
async fn approvals_indexes_upgrade_existing_store() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = butler_e2e::e2e::scenario::Setup::new("APPROVALS-INDEX-UPGRADE")?
        .start()
        .await?;
    super::seed::seed(s.sandbox.data.clone(), 3, false).await?;
    let before = s.gw.get("/authority-permissions").await?;
    assert_eq!(before.status, 200);
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = butler_platform::sqlite::open(&path)?;
    db.execute_batch("DROP INDEX IF EXISTS idx_btcc_permission_sources; DROP INDEX IF EXISTS idx_btcc_permissions_active;")?;
    drop(db);
    let app_path = s.sandbox.data.join("app-server/butler-client.sqlite");
    let app = butler_platform::sqlite::open(&app_path)?;
    app.execute_batch("DROP INDEX IF EXISTS idx_chats_authority_metadata; DROP INDEX IF EXISTS idx_projects_authority_metadata;")?;
    drop(app);
    s.gw = s.agent.restart().await?;
    let after = s.gw.get("/authority-permissions").await?;
    assert_eq!(after.status, 200);
    assert_eq!(after.data()["permissions"], before.data()["permissions"]);
    let db = butler_platform::sqlite::open(&path)?;
    for (query, index) in [
        (
            "SELECT owner_session_id,workspace_path,capability,normalized_target,normalized_input_json FROM btcc_authority_requests WHERE owner_session_id='butler/app-chat-0' AND decision='allowed' AND allow_scope='conversation' ORDER BY created_at",
            "idx_btcc_permission_sources",
        ),
        (
            "SELECT grant_ref,owner_session_id,workspace_path,created_at FROM btcc_conversation_permissions WHERE revoked_at IS NULL ORDER BY created_at DESC,grant_ref",
            "idx_btcc_permissions_active",
        ),
    ] {
        let mut statement = db.prepare(&format!("EXPLAIN QUERY PLAN {query}"))?;
        let details = statement
            .query_map([], |row| row.get::<_, String>(3))?
            .collect::<Result<Vec<_>, _>>()?;
        assert!(
            details
                .iter()
                .any(|detail| detail.contains(&format!("COVERING INDEX {index}"))),
            "{details:?}"
        );
        assert!(
            details.iter().all(|detail| !detail.contains("TEMP B-TREE")),
            "{details:?}"
        );
    }
    drop(db);
    check_metadata_indexes(&app_path)?;
    s.finish().await
}

fn check_metadata_indexes(path: &std::path::Path) -> Result<(), HarnessError> {
    let db = butler_platform::sqlite::open(path)?;
    db.execute_batch(
        "UPDATE sqlite_stat1 SET stat='1 1' WHERE tbl='chats'; ANALYZE sqlite_schema;",
    )?;
    let mut query = db.prepare(&format!(
        "EXPLAIN QUERY PLAN {}",
        super::profile::METADATA_SQL
    ))?;
    let details = query
        .query_map([r#"["butler/app-chat-0"]"#], |row| row.get::<_, String>(3))?
        .collect::<Result<Vec<_>, _>>()?;
    for index in [
        "idx_chats_authority_metadata",
        "idx_projects_authority_metadata",
    ] {
        assert!(
            details
                .iter()
                .any(|detail| detail.contains(&format!("COVERING INDEX {index}"))),
            "{details:?}"
        );
    }
    assert!(
        details.iter().all(
            |detail| !["SCAN c", "SCAN p", "SCAN explicit", "SCAN legacy"]
                .iter()
                .any(|table| detail.starts_with(table))
        ),
        "{details:?}"
    );
    Ok(())
}
