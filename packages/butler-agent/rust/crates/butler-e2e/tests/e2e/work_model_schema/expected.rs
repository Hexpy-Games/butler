//! Hand-written preview-14 upgrade oracle; independent of migration SQL.
use super::*;
use serde_json::json;
fn values(db: &Connection, sql: &str) -> rusqlite::Result<serde_json::Value> {
    Ok(json!(
        rows(db, sql)?
            .into_iter()
            .map(|row| row
                .into_iter()
                .map(|v| match v {
                    Value::Null => serde_json::Value::Null,
                    Value::Integer(n) => json!(n),
                    Value::Text(s) => json!(s),
                    Value::Real(n) => json!(n),
                    Value::Blob(bytes) => json!(bytes),
                })
                .collect::<Vec<_>>())
            .collect::<Vec<_>>()
    ))
}
pub(super) fn assert_rows(db: &Connection) -> rusqlite::Result<()> {
    for (table, count) in [
        ("canon_plans", 1),
        ("canon_epics", 9),
        ("canon_spec_nodes", 8),
        ("canon_spec_bodies", 7),
        ("canon_spec_revisions", 7),
        ("canon_spec_criteria", 1),
        ("canon_session_epics", 7),
        ("canon_audit", 4),
        ("canon_events", 1),
        ("canon_counters", 4),
        ("canon_intents", 1),
        ("canon_cursors", 0),
        ("canon_epic_work_links", 0),
    ] {
        assert_eq!(
            values(db, &format!("SELECT count(*) FROM {table}"))?,
            json!([[count]]),
            "{table}"
        );
    }
    assert_eq!(
        values(
            db,
            "SELECT id,title,status,revision FROM canon_plans ORDER BY id"
        )?,
        json!([["pl_p14", "프리뷰 14", "open", 1]])
    );
    assert_eq!(
        values(
            db,
            "SELECT id,title,plan_id,canon_status,canon_status_source,plan_rank FROM canon_epics ORDER BY id"
        )?,
        json!([
            [
                "wk_blocks",
                "시각화 블록",
                "pl_p14",
                "planned",
                "person",
                "O"
            ],
            [
                "wk_bookmarks",
                "다른 브라우저에서 북마크 가져오기",
                null,
                "planned",
                null,
                "W"
            ],
            ["wk_canon", "캐논", "pl_p14", "in_progress", "runtime", "8"],
            [
                "wk_crates",
                "크레이트 분리",
                "pl_p14",
                "planned",
                "person",
                "u"
            ],
            ["wk_docs", "문서", "pl_p14", "planned", "person", "W"],
            ["wk_images", "이미지 도구", "pl_p14", "done", "runtime", "e"],
            [
                "wk_login",
                "ChatGPT 공식 로그인",
                "pl_p14",
                "planned",
                "person",
                "m"
            ],
            [
                "wk_passkey",
                "패스키 로그인",
                null,
                "planned",
                "person",
                "G"
            ],
            ["wk_queue", "작업 큐", "pl_p14", "blocked", "runtime", "G"]
        ])
    );
    assert_eq!(
        values(
            db,
            "SELECT node_id,epic_id,visibility,active_revision FROM canon_spec_nodes ORDER BY node_id"
        )?,
        json!([
            ["sp_blocks", "wk_blocks", "canon", 1],
            ["sp_canon", "wk_canon", "canon", 1],
            ["sp_crates", "wk_crates", "canon", 1],
            ["sp_docs", "wk_docs", "canon", 1],
            ["sp_images", "wk_images", "canon", 1],
            ["sp_login", "wk_login", "canon", 1],
            ["sp_orphan", null, "canon", null],
            ["sp_queue", "wk_queue", "canon", 1]
        ])
    );
    assert_eq!(
        values(
            db,
            "SELECT session_id,epic_id,bound_at,bound_by,origin FROM canon_session_epics ORDER BY session_id"
        )?,
        json!([
            [
                "chat_blocks",
                "wk_blocks",
                1,
                "{\"person\":\"fixture\"}",
                "user"
            ],
            [
                "chat_canon",
                "wk_canon",
                1,
                "{\"person\":\"fixture\"}",
                "user"
            ],
            [
                "chat_crates",
                "wk_crates",
                1,
                "{\"person\":\"fixture\"}",
                "user"
            ],
            [
                "chat_docs",
                "wk_docs",
                1,
                "{\"person\":\"fixture\"}",
                "user"
            ],
            [
                "chat_images",
                "wk_images",
                1,
                "{\"person\":\"fixture\"}",
                "user"
            ],
            [
                "chat_login",
                "wk_login",
                1,
                "{\"person\":\"fixture\"}",
                "user"
            ],
            [
                "chat_queue",
                "wk_queue",
                1,
                "{\"person\":\"fixture\"}",
                "user"
            ]
        ])
    );
    assert_eq!(
        values(db, "SELECT * FROM canon_audit")?,
        json!([
            [1, "work", "wk_canon", 1, "{}", "create", 1, "{}"],
            [2, "plan", "pl_p14", 1, "{}", "create", 1, "{}"],
            [3, "spec_node", "sp_canon", 1, "{}", "create", 1, "{}"],
            [4, "backlog", "butler", 17, "{}", "order", 1, "{}"]
        ])
    );
    assert_eq!(
        values(
            db,
            "SELECT seq,topic,published,created_at FROM canon_events"
        )?,
        json!([[4, "canon.changed", 1, 1]])
    );
    assert_eq!(
        values(db, "SELECT * FROM canon_counters ORDER BY key")?,
        json!([
            ["project", "butler", "backlog_revision", 17],
            ["project", "butler", "epics", 9],
            ["project", "butler", "plans", 1],
            ["project", "butler", "spec_nodes", 8]
        ])
    );
    assert_eq!(
        values(db, "SELECT * FROM canon_intents")?,
        json!([["pending-op", "projection", "{}", 3, "pending", 1]])
    );
    assert_eq!(
        values(
            db,
            "SELECT node_id,revision,criterion_id,part_id,text FROM canon_spec_criteria"
        )?,
        json!([[
            "sp_canon",
            1,
            "edit",
            "main",
            "계획·과제·명세를 편집할 수 있다."
        ]])
    );
    assert_eq!(
        values(db, "SELECT hash,bytes FROM canon_spec_bodies ORDER BY hash")?,
        json!([
            [
                "5d616c39bbf9f6b504089ef27750a40770249cb90bc4312dbb82eabf34142342",
                102
            ],
            [
                "71d5d31a9b39588ae94cedea89010f0fc5dddc20225d78532be9d9a73dfce715",
                139
            ],
            [
                "791705aa8ed9ac58b9dbb1beebfdf83b586f05d3f3c259c4914a3d61217b12dd",
                78
            ],
            [
                "92ac019bab23c828ae4ccca51d612dca517d3e65b1a74cb676a477a73143815a",
                87
            ],
            [
                "a56d48fffabb68fa4f95d6486be116c8cfb5385bd1b1dc0382e601497c70799e",
                89
            ],
            [
                "baea7d50946ee5c1453ebb52e1a4eccd19e0e9519a773d4a0324a87894de55a2",
                256
            ],
            [
                "cf67b224683f1bb831cbd3b4134b82fafe5c302428015b7246d1b4fb00ef3820",
                94
            ]
        ])
    );
    assert_eq!(
        values(
            db,
            "SELECT node_id,revision,parser_version,state FROM canon_spec_revisions ORDER BY node_id"
        )?,
        json!([
            ["sp_blocks", 1, "1", "active"],
            ["sp_canon", 1, "1", "active"],
            ["sp_crates", 1, "1", "active"],
            ["sp_docs", 1, "1", "active"],
            ["sp_images", 1, "1", "active"],
            ["sp_login", 1, "1", "active"],
            ["sp_queue", 1, "1", "active"]
        ])
    );
    Ok(())
}
