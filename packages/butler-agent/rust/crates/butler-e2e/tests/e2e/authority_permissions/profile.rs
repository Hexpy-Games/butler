//! Numeric diagnostics only; response equality and latency budgets remain in the scenario.
use std::collections::BTreeMap;

pub(super) fn report(logs: &str) {
    if let Some(cache) = logs
        .lines()
        .rev()
        .find(|line| line.starts_with("approvals-cache"))
    {
        eprintln!("{cache}");
    }
    let mut stages: BTreeMap<&str, Vec<u64>> = BTreeMap::new();
    let mut metadata_reader = false;
    for line in logs
        .lines()
        .filter(|line| line.starts_with("approvals-profile"))
    {
        // The metadata closure logs before its reader commits and syncs.
        // Ignore startup/background reader jobs, rather than taking the last 100.
        if line.contains("metadata_sql_us=") {
            metadata_reader = !line.contains("metadata_lane_owned=1");
        }
        if line.contains("reader_open_us=") {
            if !metadata_reader {
                continue;
            }
            metadata_reader = false;
        }
        for field in line.split_whitespace().skip(1) {
            if let Some((key, value)) = field.split_once('=')
                && key.ends_with("_us")
                && let Ok(value) = value.parse()
            {
                stages.entry(key).or_default().push(value);
            }
        }
    }
    for (stage, mut samples) in stages {
        let cold = samples.remove(0);
        eprintln!("approvals-cold {stage} us={cold}");
        samples.sort_unstable();
        let count = samples.len();
        eprintln!("approvals-distribution {stage} {samples:?}");
        eprintln!(
            "approvals-stage {stage} samples={count} p50_us={} p95_us={} p99_us={}",
            samples[(count * 50).div_ceil(100) - 1],
            samples[(count * 95).div_ceil(100) - 1],
            samples[(count * 99).div_ceil(100) - 1]
        );
    }
}

pub(super) fn explain(db: &rusqlite::Connection) -> Result<(), rusqlite::Error> {
    let mut query = db.prepare(
        "EXPLAIN QUERY PLAN SELECT a.owner_session_id,a.workspace_path,a.capability,a.normalized_target,a.normalized_input_json,a.created_at,a.rowid \
         FROM btcc_authority_requests a INDEXED BY idx_btcc_permission_sources \
         WHERE a.owner_session_id IN (SELECT value FROM json_each(?1)) \
         AND a.decision='allowed' AND a.allow_scope='conversation'",
    )?;
    let owners: Vec<_> = (0..600).map(|i| format!("butler/app-chat-{i}")).collect();
    let owners = serde_json::to_string(&owners).unwrap();
    for detail in query.query_map([owners], |row| row.get::<_, String>(3))? {
        eprintln!("approvals-plan source {}", detail?);
    }
    let mut active = db.prepare("EXPLAIN QUERY PLAN SELECT grant_ref,owner_session_id,workspace_path,created_at FROM btcc_conversation_permissions INDEXED BY idx_btcc_permissions_active WHERE revoked_at IS NULL ORDER BY created_at DESC,grant_ref")?;
    for detail in active.query_map([], |row| row.get::<_, String>(3))? {
        eprintln!("approvals-plan active {}", detail?);
    }
    Ok(())
}

pub(super) fn explain_metadata(db: &rusqlite::Connection) -> Result<(), rusqlite::Error> {
    let mut query = db.prepare(&format!("EXPLAIN QUERY PLAN {METADATA_SQL}"))?;
    for detail in query.query_map([r#"["butler/app-chat-0"]"#], |row| row.get::<_, String>(3))? {
        eprintln!("approvals-plan metadata {}", detail?);
    }
    Ok(())
}

pub(super) const METADATA_SQL: &str = "SELECT owners.value,c.title,c.project_id,p.display_name \
    FROM json_each(?1) owners \
    LEFT JOIN chats explicit INDEXED BY chats_runtime_hint_idx \
      ON explicit.runtime_session_hint=owners.value AND explicit.runtime_session_hint IS NOT NULL \
    LEFT JOIN chats legacy INDEXED BY sqlite_autoindex_chats_1 \
      ON explicit.id IS NULL AND legacy.runtime_session_hint IS NULL \
      AND legacy.id=CASE WHEN substr(owners.value,1,11)='butler/app-' THEN substr(owners.value,12) ELSE owners.value END \
    JOIN chats c INDEXED BY idx_chats_authority_metadata ON c.id=coalesce(explicit.id,legacy.id) \
    LEFT JOIN projects p INDEXED BY idx_projects_authority_metadata ON p.id=c.project_id";
