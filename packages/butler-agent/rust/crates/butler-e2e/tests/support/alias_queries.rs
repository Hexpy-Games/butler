//! Execute all four production posting SQL strings, preserving order and counts.
use rusqlite::{Connection, types::Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
const RECALL: &str =
    include_str!("../../../butler-memory/src/cognition/graph/recall/semantic/lexical.rs");
const SELECTION: &str =
    include_str!("../../../butler-memory/src/cognition/graph/candidates/selection.rs");

fn sql(text: &str, start: &str) -> String {
    let part = &text[text.find(start).unwrap()..];
    part[..part.find('"').unwrap()].replace("\\\n", " ")
}

pub(super) fn hashes(db: &Connection, relation: &str, native: bool) -> Vec<String> {
    let surface: String = db.query_row("SELECT surface_original FROM memory_aliases ORDER BY node_id,surface_original,source_id LIMIT 1",[],|r|r.get(0)).unwrap();
    let cue: String = surface.chars().take(8).collect();
    let grams = serde_json::to_string(&super::alias_fixture::grams(&cue)).unwrap();
    let mut hashes = Vec::new();
    for (name, scope) in [
        ("all", ""),
        ("project", " AND c.project_id='project-0'"),
        ("session", " AND c.conversation_session_id='session-0'"),
        ("unassigned", " AND c.project_id IS NULL"),
        (
            "selected",
            " AND c.project_id IN ('project-0','project-1') AND c.conversation_session_id IN ('session-0','session-1')",
        ),
        ("internal", ""),
        (
            "conversation_time",
            " AND julianday(s.observed_at)>=julianday('2026-01-01') AND julianday(s.observed_at)<julianday('2026-02-01')",
        ),
        ("event_time", ""),
    ] {
        let mut frequencies = grams.clone();
        for frequency in [false, true] {
            let start = if frequency {
                "WITH eligible AS MATERIALIZED"
            } else {
                "SELECT DISTINCT p.node_id"
            };
            let raw = sql(RECALL, start);
            let mut claim = "(e.type NOT IN ('preference','goal','constraint','decision','memory_atom') OR (((SELECT valid_from FROM memory_claims WHERE node_id=e.id) IS NULL OR julianday((SELECT valid_from FROM memory_claims WHERE node_id=e.id))<=julianday('2026-10-02')) AND ((SELECT valid_to FROM memory_claims WHERE node_id=e.id) IS NULL OR julianday((SELECT valid_to FROM memory_claims WHERE node_id=e.id))>julianday('2026-10-02'))))";
            if name == "event_time" {
                claim = "(e.type NOT IN ('preference','goal','constraint','decision','memory_atom') OR ((SELECT valid_from FROM memory_claims WHERE node_id=e.id) IS NOT NULL AND julianday((SELECT valid_from FROM memory_claims WHERE node_id=e.id))<julianday('2026-09-02') AND julianday(COALESCE((SELECT valid_to FROM memory_claims WHERE node_id=e.id),'2026-09-02'))>julianday('2026-08-01')))";
            }
            let origins = if name == "internal" {
                "'user_input','assistant_public','unknown','internal_control'"
            } else {
                "'user_input','assistant_public'"
            };
            let source = format!(
                "c.status='active' AND ((s.source_kind='conversation' AND s.origin_kind IN ({origins})) OR (s.source_kind='task_report' AND s.role='task' AND s.basis='reviewed_task') OR (s.source_kind='explicit_record' AND s.role='explicit' AND s.basis='user_statement')) AND julianday(s.observed_at)<=julianday('2026-10-02'){scope}"
            );
            let raw = raw.replace(
                "{ALIAS_JOIN}",
                &sql(RECALL, "JOIN memory_nodes e ON e.id=a.node_id"),
            );
            let raw = raw.replacen("{}", claim, 1).replacen("{}", &source, 1);
            let query = adapt(&raw, relation, native && frequency);
            let (hash, rows) = measure(
                db,
                &query,
                &[Value::Text(if frequency {
                    frequencies.clone()
                } else {
                    grams.clone()
                })],
                name,
            );
            if !frequency {
                frequencies = expanded(&rows, &cue);
            }
            hashes.push(hash);
        }
    }
    let mut frequencies = grams.clone();
    for frequency in [false, true] {
        let start = if frequency {
            "WITH eligible AS MATERIALIZED"
        } else {
            "SELECT DISTINCT p.node_id"
        };
        let eligible = sql(SELECTION, "c.status='active'");
        let raw = sql(SELECTION, start).replace("{ELIGIBLE}", &eligible);
        let query = adapt(&raw, relation, native && frequency);
        let (hash, rows) = measure(
            db,
            &query,
            &[
                Value::Text("project-0".into()),
                Value::Text("2026-10-02".into()),
                Value::Text(if frequency {
                    frequencies.clone()
                } else {
                    grams.clone()
                }),
            ],
            "registration",
        );
        if !frequency {
            frequencies = expanded(&rows, &cue);
        }
        hashes.push(hash);
    }
    hashes
}

fn adapt(sql: &str, relation: &str, native: bool) -> String {
    if native {
        sql.replace("SELECT DISTINCT a.node_id,a.source_id FROM memory_aliases a","SELECT DISTINCT ad.id FROM memory_aliases a JOIN memory_alias_documents ad ON ad.node_id=a.node_id AND ad.source_id=a.source_id AND ad.surface_original=a.surface_original")
        .replace("FROM memory_alias_postings p","FROM memory_alias_grams p")
        .replace("d.node_id=p.node_id AND d.source_id=p.source_id","d.id=p.alias_id")
    } else if relation == "memory_alias_read_postings"
        && sql.contains("WITH eligible AS MATERIALIZED")
    {
        sql.to_owned()
    } else {
        sql.replace("memory_alias_postings", relation)
    }
}

fn measure(db: &Connection, sql: &str, args: &[Value], label: &str) -> (String, Vec<Vec<Value>>) {
    let plan: Vec<String> = db
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map(rusqlite::params_from_iter(args), |r| r.get(3))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(
        !plan
            .iter()
            .any(|p| p.contains("SCAN memory_alias_grams")
                || p.contains("SCAN memory_alias_postings")),
        "posting scan {label}: {plan:?}"
    );
    // A UNION adapter materializes only the gram-probed rows, then scans that
    // bounded result. Both base posting branches must still use gram probes.
    let partitioned: bool = sql.contains("memory_alias_read_postings") && db.query_row(
        "SELECT instr(sql,'UNION ALL')>0 FROM sqlite_schema WHERE name='memory_alias_read_postings'", [], |r| r.get(0)
    ).unwrap();
    let probes = plan
        .iter()
        .filter(|p| p.contains("gram=?") && p.contains("SEARCH"))
        .count();
    assert!(
        probes >= if partitioned { 2 } else { 1 },
        "missing posting branch gram probe {label}: {plan:?}"
    );
    let start = Instant::now();
    let mut stmt = db.prepare(sql).unwrap();
    let n = stmt.column_count();
    let rows: Vec<Vec<Value>> = stmt
        .query_map(rusqlite::params_from_iter(args), |r| {
            (0..n).map(|i| r.get(i)).collect()
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let elapsed = start.elapsed();
    let mut hash = Sha256::new();
    for row in &rows {
        hash.update(format!("{row:?}\n"));
    }
    let hash = format!("{:x}", hash.finalize());
    eprintln!(
        "ALIAS query={label} rows={} hash={hash} elapsed={elapsed:?}",
        rows.len()
    );
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_secs(2),
        "complete alias posting query"
    );
    (hash, rows)
}

// Exactly the query and matched-document grams requested by both recall paths.
fn expanded(rows: &[Vec<Value>], cue: &str) -> String {
    let mut grams = super::alias_fixture::grams(cue);
    for row in rows {
        let Value::Text(surface) = &row[2] else {
            panic!("alias surface")
        };
        grams.extend(super::alias_fixture::grams(surface));
    }
    serde_json::to_string(&grams).unwrap()
}
