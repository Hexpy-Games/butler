use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use chrono::{DateTime, Utc};
use serde_json::json;

use super::*;
use crate::{
    coordination::{CognitionCoordinationHost, CognitionProcessStatus, CoordinationResult},
    models::{ProviderPromptFuture, ProviderPromptResult},
};

struct Facts;
impl CognitionCoordinationHost for Facts {
    fn process_id(&self) -> u32 {
        std::process::id()
    }
    fn hostname(&self) -> CoordinationResult<String> {
        Ok("briefing-test".into())
    }
    fn process_status(&self, pid: u64) -> CognitionProcessStatus {
        if pid == u64::from(std::process::id()) {
            CognitionProcessStatus::Alive
        } else {
            CognitionProcessStatus::DefinitelyDead
        }
    }
    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn now_epoch_millis(&self) -> i64 {
        i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap_or(i64::MAX)
    }
    fn now_iso(&self) -> String {
        "2026-09-23T00:00:00.000Z".into()
    }
}

struct Source(Mutex<BriefingInputSnapshot>);
impl BriefingInputSource for Source {
    fn snapshot(&self) -> BriefingInputFuture<'_> {
        Box::pin(async { Ok(self.0.lock().unwrap().clone()) })
    }
    fn local_minute(&self, _: i64) -> Result<u16, BriefingGenerationError> {
        Ok(9 * 60)
    }
}

struct Provider {
    calls: AtomicUsize,
    change_source: Option<Arc<Source>>,
    prompts: Mutex<Vec<String>>,
}
impl ProviderPromptPort for Provider {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        _: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.prompts.lock().unwrap().push(request.prompt.to_owned());
        let project = request.prompt.contains("project_new_chat_briefing");
        if let Some(source) = &self.change_source {
            source.0.lock().unwrap().persona.text = Some("new persona".into());
        }
        let mut output = json!({
            "moment":"Morning", "title":"Open today", "description":"A useful start",
            "suggestions":(0..5).map(|index| json!({
                "id":format!("card-{index}"), "title":format!("Topic {index}"),
                "description":"Why it matters", "text":"Please help with this",
            })).collect::<Vec<_>>(),
        });
        if !project {
            output["title_variants"] = json!({"morning":"Good morning","afternoon":"Good afternoon","evening":"Good evening","night":"Good night"});
        }
        Box::pin(async move {
            Ok(ProviderPromptResult {
                text: output.to_string(),
                model: "local/test".into(),
                usage: None,
            })
        })
    }
}

fn input() -> BriefingInputSnapshot {
    BriefingInputSnapshot {
        settings: BriefingSettings::Configured {
            locale: "en".into(),
            model: "local/test".into(),
            reasoning_effort: ReasoningEffort::Medium,
        },
        persona: BriefingPersona {
            id: None,
            text: None,
        },
        projection: None,
        projects: vec![BriefingProjectSignal {
            id: "project-1".into(),
            display_name: "Project One".into(),
            summary: None,
            recent_session_titles: vec![],
            ledger_event_summary: vec!["work:active x1".into()],
            open_work_titles: vec![],
            completed_work_titles: vec![],
            excluded_topics: vec![],
        }],
    }
}

fn root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "butler-briefing-generation-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

fn service(root: &Path, source: Arc<Source>, provider: Arc<Provider>) -> BriefingGenerationService {
    BriefingGenerationService::new(
        root.to_path_buf(),
        Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts)).unwrap()),
        provider,
        source,
    )
}

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-09-23T00:00:00.000Z")
        .unwrap()
        .with_timezone(&Utc)
}

#[tokio::test]
async fn generates_durable_general_and_project_artifacts_from_model() {
    let root = root();
    let source = Arc::new(Source(Mutex::new(input())));
    let provider = Arc::new(Provider {
        calls: AtomicUsize::new(0),
        change_source: None,
        prompts: Mutex::new(vec![]),
    });
    let result = service(&root, source, provider.clone())
        .generate("cr_test", now(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["generated_count"], 2);
    assert_eq!(result["failed_count"], 0);
    assert_eq!(result["model_usage"]["request_count"], 2);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    let general =
        super::super::read_new_chat_briefing(&root, Some("2026-09-23"), "general", None, "en")
            .unwrap();
    assert_eq!(general["title_variants"]["morning"], "Good morning");
    assert_eq!(general["source"]["consolidation_run_id"], "cr_test");
    assert!(!general.to_string().contains("Project One"));
    let project = super::super::read_new_chat_briefing(
        &root,
        Some("2026-09-23"),
        "project",
        Some("project-1"),
        "en",
    )
    .unwrap();
    assert_eq!(project["project_name"], "Project One");
    assert!(project.get("title_variants").is_none());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn project_briefing_keeps_source_context_filters_exclusions_and_has_no_project_cap() {
    let root = root();
    let mut snapshot = input();
    snapshot.projects = (0..13)
        .map(|index| BriefingProjectSignal {
            id: format!("project-{index}"),
            display_name: format!("Project {index}"),
            summary: (index == 0).then(|| "A useful project summary".into()),
            recent_session_titles: if index == 0 {
                vec!["Recent topic".into()]
            } else {
                vec![]
            },
            ledger_event_summary: vec!["work.updated:in_progress x1".into()],
            open_work_titles: if index == 0 {
                vec!["Open implementation".into()]
            } else {
                vec![]
            },
            completed_work_titles: if index == 0 {
                vec!["Completed review".into()]
            } else {
                vec![]
            },
            excluded_topics: if index == 0 {
                vec!["topic 0".into()]
            } else {
                vec![]
            },
        })
        .collect();
    let source = Arc::new(Source(Mutex::new(snapshot)));
    let provider = Arc::new(Provider {
        calls: AtomicUsize::new(0),
        change_source: None,
        prompts: Mutex::new(vec![]),
    });
    let result = service(&root, source, provider.clone())
        .generate("cr_many_projects", now(), &CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(result["generated_count"], 14);
    assert_eq!(
        result["project_artifact_paths"].as_array().unwrap().len(),
        13
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 14);
    let prompt = provider
        .prompts
        .lock()
        .unwrap()
        .iter()
        .filter_map(|prompt| serde_json::from_str::<Value>(prompt).ok())
        .find(|prompt| prompt["project"]["id"] == "project-0")
        .unwrap();
    assert_eq!(prompt["project"]["summary"], "A useful project summary");
    assert_eq!(
        prompt["project"]["recent_session_titles"][0],
        "Recent topic"
    );
    assert_eq!(
        prompt["project"]["open_work_titles"][0],
        "Open implementation"
    );
    assert_eq!(
        prompt["project"]["completed_work_titles"][0],
        "Completed review"
    );
    assert_eq!(prompt["project"]["excluded_topics"][0], "topic 0");
    assert!(prompt["scope_rules"].as_array().unwrap().iter().any(|rule| {
        rule.as_str()
            == Some("Treat recent session titles as topics already discussed, not as unfinished tasks or requests to repeat.")
    }));
    let project = super::super::read_new_chat_briefing(
        &root,
        Some("2026-09-23"),
        "project",
        Some("project-0"),
        "en",
    )
    .unwrap();
    assert_eq!(project["suggestions"].as_array().unwrap().len(), 4);
    assert!(!project.to_string().to_lowercase().contains("topic 0"));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn changed_source_prevents_commit_and_unconfigured_source_skips_model() {
    let root = root();
    let source = Arc::new(Source(Mutex::new(input())));
    let provider = Arc::new(Provider {
        calls: AtomicUsize::new(0),
        change_source: Some(source.clone()),
        prompts: Mutex::new(vec![]),
    });
    let result = service(&root, source.clone(), provider.clone())
        .generate("cr_test", now(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["generated_count"], 0);
    assert_eq!(result["failed_count"], 2);
    assert!(
        super::super::read_new_chat_briefing(&root, Some("2026-09-23"), "general", None, "en")
            .is_none()
    );
    source.0.lock().unwrap().settings = BriefingSettings::Unavailable {
        locale: "en".into(),
        reason: "missing_model",
    };
    let calls = provider.calls.load(Ordering::SeqCst);
    let result = service(&root, source, provider.clone())
        .generate("cr_next", now(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["outcome"], "configuration_unavailable");
    assert_eq!(result["skip_reason"], "missing_model");
    assert_eq!(provider.calls.load(Ordering::SeqCst), calls);
    fs::remove_dir_all(root).unwrap();
}
