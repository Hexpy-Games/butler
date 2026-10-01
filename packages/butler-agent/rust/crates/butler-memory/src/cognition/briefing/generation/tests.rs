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
use crate::cognition::BriefingScope;
use crate::coordination::{CognitionCoordinationHost, CognitionProcessStatus, CoordinationResult};
use butler_models::models::{ProviderPromptFuture, ProviderPromptResult};

mod format_pin;

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
        super::super::read_new_chat_briefing(
            &root,
            Some("2026-09-23"),
            BriefingScope::General,
            None,
            "en"
        )
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
