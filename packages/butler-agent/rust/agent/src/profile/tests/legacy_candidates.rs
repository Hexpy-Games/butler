use rusqlite::params;
use serde_json::{Value, json};

use super::*;

#[tokio::test]
async fn consolidation_hydrates_legacy_rows_and_expires_after_promotion_pass() {
    let root = Root::new("legacy-consolidation");
    let (service, _) = service(&root, HashMap::new());
    service
        .set_profiling_mode(ProfilingMode::Basic)
        .await
        .unwrap();
    let db = storage::open(&root.0, true).unwrap();
    insert(
        &db,
        "bad",
        "communication",
        json!({"summary":"  "}),
        "high",
        "explicit",
        false,
        "2000-01-01T00:00:00.000Z",
        None,
    );
    insert(
        &db,
        "normalized",
        "communication",
        json!({"summary":"Concise","butler_should":["Keep this"],"sensitivity":"restricted"}),
        "high",
        "explicit",
        true,
        "2000-01-01T00:00:00.000Z",
        None,
    );
    insert(
        &db,
        "disallowed",
        "identity",
        json!({"summary":"Identity"}),
        "low",
        "inference",
        false,
        "2000-01-01T00:00:00.000Z",
        Some("decay"),
    );
    insert(
        &db,
        "invalid-time",
        "boundaries",
        json!({"summary":"Ask first"}),
        "low",
        "inference",
        false,
        "invalid",
        Some("decay"),
    );
    insert(
        &db,
        "fractional",
        "epistemic_style",
        json!({"summary":"Show evidence","evidence_count":2.5,"butler_should":["Preserve exactly"]}),
        "medium",
        "inference",
        false,
        "2023-11-14T22:13:20.000Z",
        None,
    );
    drop(db);

    let result = service.consolidate_profile_candidates().await.unwrap();
    let db = storage::open(&root.0, false).unwrap();
    let rows = db
        .prepare(
            "SELECT id,category,payload_json,source_type,confidence,sensitive_domain,created_at,updated_at,last_seen_at,expires_or_decay,status,promoted_at FROM profile_candidates ORDER BY id",
        )
        .unwrap()
        .query_map([], |row| {
            let status = row.get::<_, String>(10)?;
            let changed = matches!(status.as_str(), "promoted" | "expired");
            Ok(json!({
                "id":row.get::<_, String>(0)?,
                "category":row.get::<_, String>(1)?,
                "payload_json":serde_json::from_str::<Value>(&row.get::<_, String>(2)?).unwrap(),
                "source_type":row.get::<_, String>(3)?,
                "confidence":row.get::<_, String>(4)?,
                "sensitive_domain":row.get::<_, i64>(5)?,
                "created_at":row.get::<_, String>(6)?,
                "updated_at":if changed { "<operation-now>".into() } else { row.get::<_, String>(7)? },
                "last_seen_at":row.get::<_, String>(8)?,
                "expires_or_decay":row.get::<_, Option<String>>(9)?,
                "status":status,
                "promoted_at":row.get::<_, Option<String>>(11)?.map(|_| "<operation-now>"),
            }))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let expected: Value =
        serde_json::from_str(include_str!("bun-legacy-candidates-golden.json")).unwrap();
    assert_eq!(
        json!({"result":serde_json::to_value(result).unwrap(),"stored":rows}),
        expected
    );
}

#[allow(clippy::too_many_arguments)]
fn insert(
    db: &rusqlite::Connection,
    id: &str,
    category: &str,
    payload: Value,
    confidence: &str,
    source: &str,
    sensitive: bool,
    updated: &str,
    expires: Option<&str>,
) {
    db.execute(
        "INSERT INTO profile_candidates(id,category,payload_json,source_type,confidence,sensitive_domain,created_at,updated_at,last_seen_at,expires_or_decay,status)VALUES(?1,?2,?3,?4,?5,?6,?7,?7,?7,?8,'candidate')",
        params![id, category, payload.to_string(), source, confidence, sensitive as i64, updated, expires],
    )
    .unwrap();
}
