//! Format pin of the generated New Chat Briefing view over stored briefing
//! artifacts: the greeting per time of day, the project source fields, and
//! the suggestion cards.
//!
//! The golden in `fixtures/generated-view.json` was generated from the
//! pre-typing reader and view (merge-base e1d5f72b1), which read the stored
//! artifact as a `serde_json::Value`. Run with `BUTLER_BLESS_FORMAT=1` to
//! regenerate it only when a format change is intended.

use std::{fs, path::Path};

use serde_json::{Value, json};

use super::generated_view;
use butler_memory::cognition::{self, BriefingScope};

fn cards(count: usize) -> Vec<Value> {
    (0..count)
        .map(|index| {
            json!({"id":format!("card-{index}"),"title":format!("Title {index}"),
            "description":"Why","text":format!("Start {index}"),"source_kind":"current_interest"})
        })
        .collect()
}

fn artifact(scope: &str, project: Option<(&str, &str)>, variants: bool) -> Value {
    let mut artifact = json!({
        "schema":"butler.cognition.new-chat-briefing.v1","briefing_id":"ncb_pin",
        "scope":scope,"project_id":project.map(|(id, _)| id),
        "project_name":project.map(|(_, name)| name),"locale":"en","moment":"Early start",
        "title":"Open today","description":"A useful start","suggestions":cards(5),
        "source":{"consolidation_run_id":"cr_pin","generated_at":"2026-09-23T00:00:00.000Z",
            "persona_id":"persona-1","persona_applied":true,"profile_projection_id":"pp-1",
            "profile_projection_updated_at":null,"project_ledger_snapshot_id":null,
            "model_ref":"local/test","reasoning_effort":"medium","raw_text_included":false},
        "raw_text_included":false
    });
    if variants {
        artifact["title_variants"] = json!({"morning":"Good morning",
            "afternoon":"Good afternoon","evening":"Good evening","night":"Good night"});
    }
    artifact
}

fn write(root: &Path, relative: &str, artifact: &Value) {
    let path = root
        .join("cognition/consolidation/briefings/2026-09-23")
        .join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec_pretty(artifact).unwrap()).unwrap();
}

#[test]
fn generated_view_keeps_its_bytes() {
    let root = std::env::temp_dir().join(format!("butler-briefing-view-{}", uuid::Uuid::new_v4()));
    write(&root, "general.json", &artifact("general", None, true));
    let mut project = artifact("project", Some(("project-1", "Project One")), false);
    project["suggestions"][4] = json!("not a card");
    project["source"]["profile_projection_id"] = json!("");
    write(&root, "projects/project-1.json", &project);
    let mut plain = artifact("project", Some(("project-2", "Project Two")), false);
    plain["moment"] = Value::Null;
    plain["project_name"] = Value::Null;
    write(&root, "projects/project-2.json", &plain);
    let mut views = Vec::new();
    for (scope, project) in [
        (BriefingScope::General, None),
        (BriefingScope::Project, Some("project-1")),
        (BriefingScope::Project, Some("project-2")),
    ] {
        let artifact =
            cognition::read_new_chat_briefing(&root, Some("2026-09-23"), scope, project, "en")
                .unwrap();
        for bucket in ["morning", "night"] {
            views.push(generated_view(&artifact, "9:00 AM", bucket));
        }
    }
    let _ = fs::remove_dir_all(&root);
    let text = butler_core::json::pretty(&json!(views));
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/gateway/application/new_chat_briefing/fixtures/generated-view.json");
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        fs::write(&path, &text).unwrap();
        return;
    }
    let expected = fs::read_to_string(&path).unwrap();
    assert_eq!(text, expected, "new chat briefing view format changed");
}
