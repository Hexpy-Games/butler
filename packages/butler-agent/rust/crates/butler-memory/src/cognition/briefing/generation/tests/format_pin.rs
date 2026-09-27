//! Format pin of new-chat briefing artifacts, prompts and run metrics.
//!
//! The golden in `format-pin.json` was generated from the pre-typing
//! `serde_json::Value` artifact code. Briefing ids and the temporary root
//! are normalized. Run with `BUTLER_BLESS_FORMAT=1` to regenerate it only
//! when a format change is intended.

use serde_json::json;

use super::*;

struct Scripted(Mutex<Vec<String>>);

impl ProviderPromptPort for Scripted {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        _: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        self.0.lock().unwrap().push(request.prompt.to_owned());
        let project = request.prompt.contains("project_new_chat_briefing");
        let mut output = json!({
            "moment": if project { json!(null) } else { json!("  Early   start ") },
            "title": "Open   today", "description": " A useful\tstart ",
            "suggestions": [
                {"id":"Card One!","title":"Topic  one","description":"Why","text":"Help","source_kind":"current_interest"},
                {"title":"한글 제목 Title","description":"Why","text":"Help","source_kind":"bogus"},
                {"id":"card-one","title":"Duplicate","description":"Why","text":"Help"},
                "not an object",
                {"id":"missing-text","title":"No text","description":"Why"},
                {"id":"secret","title":"About Topic Zero","description":"Why","text":"Help","source_kind":"project_status"},
                {"id":"card-3","title":"Three","description":"Why","text":"Help","source_kind":"project_decision"},
                {"id":"card-4","title":"Four","description":"Why","text":"Help"},
                {"id":"card-5","title":"Five","description":"Why","text":"Help"},
                {"id":"card-6","title":"Six","description":"Why","text":"Help"},
                {"id":"card-7","title":"Seven","description":"Why","text":"Help"}
            ],
        });
        if !project {
            output["title_variants"] = json!({"night":"Good night","morning":" Good  morning ","afternoon":"Good afternoon","evening":"Good evening","extra":"x"});
        }
        let text = format!("```json\n{output}\n```");
        Box::pin(async move {
            Ok(ProviderPromptResult {
                text,
                model: String::new(),
                usage: None,
            })
        })
    }
}

#[tokio::test]
async fn briefing_artifacts_prompts_and_metrics_keep_their_bytes() {
    let root = root();
    let mut snapshot = input();
    snapshot.persona = BriefingPersona {
        id: Some("persona-1".into()),
        text: Some("Be warm".into()),
    };
    snapshot.projects[0].excluded_topics = vec!["topic zero".into()];
    snapshot.projects.push(BriefingProjectSignal {
        id: "quiet".into(),
        display_name: "Quiet".into(),
        summary: None,
        recent_session_titles: vec![],
        ledger_event_summary: vec![],
        open_work_titles: vec![],
        completed_work_titles: vec![],
        excluded_topics: vec![],
    });
    let provider = Arc::new(Scripted(Mutex::new(Vec::new())));
    let result = BriefingGenerationService::new(
        root.clone(),
        Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts)).unwrap()),
        provider.clone(),
        Arc::new(Source(Mutex::new(snapshot))),
    )
    .generate("cr_pin", now(), &CancellationToken::new())
    .await
    .unwrap();
    let day = root.join("cognition/consolidation/briefings/2026-09-23");
    let artifacts = [
        day.join("general.json"),
        day.join("projects/project-1.json"),
    ]
    .map(|path| fs::read_to_string(path).unwrap());
    let pinned = json!({
        "result": result,
        "artifacts": artifacts,
        "prompts": *provider.0.lock().unwrap(),
    });
    let text = butler_core::json::pretty(&pinned).replace(&root.display().to_string(), "<root>");
    fs::remove_dir_all(&root).unwrap();
    let text = regex::Regex::new(r"ncb_[0-9a-f-]{36}")
        .unwrap()
        .replace_all(&text, "ncb_<id>")
        .into_owned();
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/cognition/briefing/generation/tests/format-pin.json");
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        fs::write(&path, &text).unwrap();
        return;
    }
    let expected = fs::read_to_string(&path).unwrap();
    assert_eq!(text, expected, "briefing format changed");
}
