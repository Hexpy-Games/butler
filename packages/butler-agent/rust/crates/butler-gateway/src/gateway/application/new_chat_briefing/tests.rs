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

use super::{fallback, generated_view};
use butler_memory::cognition::{self, BriefingScope};

fn assert_general_fallback_uses_everyday_cards_in_both_locales() {
    let expected = [
        (
            "ko",
            json!([
                {"id":"organize-download-folder","title":"다운로드 폴더 정리하기","description":"이 컴퓨터의 파일을 살펴보고 옮기기 전에 묻습니다.","text":"다운로드 폴더를 종류별로 정리해줘. 옮기기 전에 계획부터 보여줘."},
                {"id":"summarize-document","title":"문서 요약하기","description":"첨부하거나 붙여 넣은 문서의 핵심을 정리합니다.","text":"이 내용을 핵심만 요약해줘: "},
                {"id":"draft-reply","title":"답장 초안 쓰기","description":"짧은 메모를 바탕으로 답장 초안을 씁니다.","text":"이 메모로 답장 초안을 써줘: "},
                {"id":"morning-briefing","title":"매일 아침 브리핑 받기","description":"날씨·뉴스·일정을 8시에 전하는 예약 작업을 만듭니다.","text":"매일 아침 8시에 날씨와 뉴스, 오늘 일정을 알려주는 예약 작업을 만들어줘."}
            ]),
        ),
        (
            "en",
            json!([
                {"id":"organize-download-folder","title":"Downloads folder cleanup","description":"Butler checks files on this computer and asks before moving them.","text":"Sort my Downloads folder by type. Show me the plan before moving anything."},
                {"id":"summarize-document","title":"Document summary","description":"Attach or paste a document to get the key points.","text":"Summarize this in a few key points: "},
                {"id":"draft-reply","title":"Reply draft","description":"Turn a short note into a clear reply.","text":"Draft a reply from this note: "},
                {"id":"morning-briefing","title":"Morning briefing","description":"Create a daily 8 AM schedule for weather, news, and today's plans.","text":"Create a daily 8 AM schedule with weather, news, and today's plans."}
            ]),
        ),
    ];
    for (locale, suggestions) in expected {
        let value = fallback(
            "general",
            locale,
            "2026-10-01T00:00:00Z",
            "8:00 AM",
            None,
            None,
            None,
        );
        assert_eq!(value["suggestions"], suggestions, "{locale}");
    }
}

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

// test-category: format-pin
#[test]
fn generated_view_keeps_its_bytes() {
    assert_general_fallback_uses_everyday_cards_in_both_locales();
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
