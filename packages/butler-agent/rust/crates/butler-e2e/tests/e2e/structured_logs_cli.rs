//! Closed CLI segments remain queryable and the service owns their retention.
use super::*;
use butler_e2e::e2e::scenario::Scenario;
use std::{collections::BTreeSet, fs, path::PathBuf};

fn segments(s: &Scenario) -> Result<BTreeSet<PathBuf>, HarnessError> {
    let mut paths = BTreeSet::new();
    for lane in ["main", "debug"] {
        let dir = s.sandbox.data.join("logs/agent").join(lane);
        if dir.exists() {
            for entry in fs::read_dir(dir)? {
                let path = entry?.path();
                if path.extension().is_some_and(|ext| ext == "jsonl") {
                    paths.insert(path);
                }
            }
        }
    }
    Ok(paths)
}

fn cli(s: &Scenario, command: &str) -> Result<Vec<PathBuf>, HarnessError> {
    let before = segments(s)?;
    let output = s.agent.cli(&["remote", command, "--json"])?;
    assert_eq!(output.code, Some(0));
    assert_eq!(output.stderr, "");
    assert!(!output.json()?["data"].is_null());
    let mut created = Vec::new();
    for path in segments(s)?.difference(&before) {
        let rows = fs::read_to_string(path)?
            .lines()
            .map(serde_json::from_str::<Value>)
            .collect::<Result<Vec<_>, _>>()?;
        if rows.iter().any(local) {
            created.push(path.clone());
        }
    }
    assert!(!created.is_empty(), "CLI must write its own segment");
    Ok(created)
}

fn local(row: &Value) -> bool {
    row["category"] == "http.local" && row["event"] == "http.request"
}

async fn all_rows(s: &Scenario, query: &str) -> Result<Vec<Value>, HarnessError> {
    let mut path = query.to_owned();
    let mut rows = Vec::new();
    loop {
        let reply = s.gw.get(&path).await?;
        assert_eq!(reply.status, 200);
        rows.extend(reply.data()["rows"].as_array().unwrap().iter().cloned());
        if let Some(cursor) = reply.data()["cursor"].as_str() {
            path = format!("{query}&cursor={cursor}");
        } else {
            assert_eq!(reply.data()["exhausted"], true);
            return Ok(rows);
        }
    }
}

async fn listed(s: &Scenario, expected: &[Value]) -> Result<Vec<Value>, HarnessError> {
    let rows = all_rows(s, "/logs?limit=1000").await?;
    assert!(
        rows.windows(2)
            .all(|pair| pair[0]["ts"].as_str() >= pair[1]["ts"].as_str())
    );
    let actual: Vec<_> = rows.iter().filter(|row| local(row)).cloned().collect();
    assert_eq!(actual, expected, "complete CLI rows in newest-first order");
    let filtered = all_rows(s, "/logs?category=http.local&limit=1000").await?;
    assert_eq!(filtered, expected);
    Ok(rows)
}

#[tokio::test]
async fn logs_cli_rows_survive_close_and_index_rebuild() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("LOG-CLI-CLOSE")?
        .data_folder_token()
        .start()
        .await?;
    super::super::outbound_http::logging(&s, "detailed").await?;
    let mut paths = Vec::new();
    let mut expected = Vec::new();
    for command in ["status", "devices", "status"] {
        s.gw.patch("/settings", json!({"reduce_motion":true}))
            .await?;
        let created = cli(&s, command)?;
        let mut records = Vec::new();
        for path in &created {
            let bytes = fs::read_to_string(path)?;
            assert!(bytes.ends_with('\n'), "complete JSONL segment");
            for line in bytes.lines() {
                records.push(serde_json::from_str::<Value>(line)?);
            }
        }
        let rows: Vec<_> = records.iter().filter(|row| local(row)).cloned().collect();
        assert_eq!(rows.len(), 1, "one completed HTTP call per command");
        let row = &rows[0];
        assert_eq!(row["attrs"]["method"], "GET");
        assert_eq!(
            row["attrs"]["path"],
            if command == "devices" {
                "/security/devices"
            } else {
                "/security"
            }
        );
        assert_eq!(row["attrs"]["status"], 200);
        assert_eq!(row["attrs"]["response_complete"], true);
        assert!(row["attrs"]["response_bytes"].as_u64().unwrap() > 0);
        assert!(row["duration_ms"].as_f64().unwrap() >= 0.0);
        expected.extend(rows);
        paths.extend(created);
    }
    s.gw.patch("/settings", json!({"reduce_motion":false}))
        .await?;
    expected.reverse();
    let before = listed(&s, &expected).await?;
    let newest = before.iter().position(local).unwrap();
    let oldest = before.iter().rposition(local).unwrap();
    assert!(
        before[newest + 1..oldest]
            .iter()
            .any(|r| r["category"] == "http.server")
    );
    s.agent.terminate().await?;
    // Drop only the exited CLI's published sidecars to exercise open-time
    // repair of closed segments without any finalized index.
    for path in &paths {
        fs::remove_file(path.with_extension("idx"))?;
    }
    s.gw = s.agent.start_again().await?;
    let after = listed(&s, &expected).await?;
    for row in before {
        assert!(
            after.contains(&row),
            "agent and CLI records survive restart"
        );
    }
    assert!(
        paths
            .iter()
            .all(|path| path.with_extension("idx").is_file())
    );
    eprintln!("LOG-CLI-CLOSE commands=3 complete_rows=3 restart_rows=3");
    s.finish().await
}

#[tokio::test]
async fn logs_agent_retains_recent_and_prunes_old_cli_segments() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("LOG-CLI-RETENTION")?
        .data_folder_token()
        .start()
        .await?;
    super::super::outbound_http::logging(&s, "detailed").await?;
    let paths = cli(&s, "status")?;
    let source = paths
        .iter()
        .find(|path| path.parent().unwrap().ends_with("debug"))
        .unwrap();
    let original = fs::read_to_string(source)?;
    s.agent.terminate().await?;
    let mut seeded = Vec::new();
    for hours in [96, 1] {
        let ts = chrono::Utc::now() - chrono::Duration::hours(hours);
        let path = source
            .parent()
            .unwrap()
            .join(format!("{}-0001.jsonl", ts.format("%Y%m%dT%H%M%SZ")));
        let mut bytes = String::new();
        for line in original.lines() {
            let mut row: Value = serde_json::from_str(line)?;
            row["ts"] = ts
                .to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
                .into();
            bytes.push_str(&serde_json::to_string(&row)?);
            bytes.push('\n');
        }
        fs::write(&path, bytes)?;
        fs::OpenOptions::new()
            .write(true)
            .open(&path)?
            .set_times(fs::FileTimes::new().set_modified(ts.into()))?;
        assert!(path.is_file());
        assert!(!path.with_extension("idx").exists());
        seeded.push(path);
    }
    s.gw = s.agent.start_again().await?;
    assert!(
        !seeded[0].exists(),
        "agent startup prunes expired CLI segment"
    );
    assert!(seeded[1].is_file(), "recent CLI segment is retained");
    assert!(seeded[1].with_extension("idx").is_file());
    let reply = s.gw.get("/logs?category=http.local&limit=1000").await?;
    assert_eq!(reply.status, 200);
    let rows = reply.data()["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "original and recent CLI records remain");
    for line in fs::read_to_string(&seeded[1])?.lines() {
        assert!(rows.contains(&serde_json::from_str::<Value>(line)?));
    }
    eprintln!("LOG-CLI-RETENTION expired_h=96 kept_h=1 remaining_rows=2");
    s.finish().await
}
