
use super::*;
use serde_json::json;

#[test]
fn reads_existing_valid_artifact_and_rejects_wrong_scope() {
    let root =
        std::env::temp_dir().join(format!("butler-briefing-reader-{}", uuid::Uuid::new_v4()));
    let day = root.join("cognition/consolidation/briefings/2026-09-23");
    fs::create_dir_all(&day).unwrap();
    let artifact = json!({
        "schema":"butler.cognition.new-chat-briefing.v1", "scope":"general", "project_id":null,
        "locale":"en", "moment":"Morning", "title":"Welcome", "description":"Today",
        "title_variants":{"morning":"Good morning", "afternoon":"Good afternoon", "evening":"Good evening", "night":"Good night"},
        "suggestions":[
            {"id":"one","title":"One","description":"One","text":"One"},
            {"id":"two","title":"Two","description":"Two","text":"Two"},
            {"id":"three","title":"Three","description":"Three","text":"Three"},
            {"id":"four","title":"Four","description":"Four","text":"Four"}
        ],
        "source":{"consolidation_run_id":"cr_test", "generated_at":"2026-09-23T00:00:00.000Z", "raw_text_included":false},
        "raw_text_included":false
    });
    fs::write(
        day.join("general.json"),
        serde_json::to_vec(&artifact).unwrap(),
    )
    .unwrap();
    assert_eq!(
        read_new_chat_briefing(&root, None, "general", None, "en"),
        Some(artifact)
    );
    assert!(read_new_chat_briefing(&root, None, "project", Some("p"), "en").is_none());
    assert!(read_new_chat_briefing(&root, Some("../escape"), "general", None, "en").is_none());
    assert!(read_new_chat_briefing(&root, Some(" 2026-09-23 "), "general", None, "en").is_some());
    for index in 1..=65 {
        fs::create_dir_all(root.join(format!(
            "cognition/consolidation/briefings/2026-10-{index:02}"
        )))
        .unwrap();
    }
    assert!(read_new_chat_briefing(&root, None, "general", None, "en").is_some());
    let runs = root.join("cognition/consolidation/runs");
    fs::create_dir_all(&runs).unwrap();
    fs::write(
        runs.join("old.json"),
        r#"{"status":"completed","run_id":"cr_old","started_at":"2026-09-23T00:00:00.000Z"}"#,
    )
    .unwrap();
    for index in 1..=65 {
        fs::write(
            runs.join(format!("new-{index:02}.json")),
            r#"{"status":"completed_with_errors","run_id":"cr_failed"}"#,
        )
        .unwrap();
    }
    assert_eq!(
        latest_completed_briefing_run_id(&root, None).as_deref(),
        Some("cr_old")
    );
    assert_eq!(
        latest_completed_briefing_run_id(&root, Some("2026-09-23")).as_deref(),
        Some("cr_old")
    );
    assert!(latest_completed_briefing_run_id(&root, Some("2026")).is_none());
    fs::remove_dir_all(root).unwrap();
}
