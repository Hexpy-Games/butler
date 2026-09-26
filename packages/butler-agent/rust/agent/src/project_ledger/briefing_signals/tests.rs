
use std::{fs, path::PathBuf};

use crate::locale::LocaleCollation;

use super::{ProjectBriefingTarget, read};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("butler-briefing-ledger-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("project-ledger/projects/ledger-alpha/work/W-OPEN")).unwrap();
        fs::create_dir_all(root.join("project-ledger/projects/ledger-alpha/work/W-DONE")).unwrap();
        fs::create_dir_all(root.join("cognition/consolidation")).unwrap();
        fs::write(
            root.join("project-ledger/projects/ledger-alpha/project.json"),
            r#"{"id":"ledger-alpha","name":"Ledger Alpha","summary":"Project summary"}"#,
        )
        .unwrap();
        fs::write(
            root.join("project-ledger/projects/ledger-alpha/ledger.jsonl"),
            "{\"type\":\"work.updated\",\"status\":\"in_progress\"}\n",
        )
        .unwrap();
        fs::write(
                root.join("project-ledger/projects/ledger-alpha/work/W-OPEN/work.md"),
                "---\ntitle: Persona routing\nstatus: in_progress\nupdatedAt: 2026-09-25T00:00:00Z\n---\n",
            )
            .unwrap();
        fs::write(
                root.join("project-ledger/projects/ledger-alpha/work/W-DONE/work.md"),
                "---\ntitle: \"Finished routing\"\nstatus: \"done\"\nupdatedAt: \"2026-09-24T00:00:00Z\"\n---\n",
            )
            .unwrap();
        fs::write(
            root.join("cognition/consolidation/briefing-exclusions.json"),
            r#"{"projects":{"app-alpha":["canary", " canary ", "카나리"]}}"#,
        )
        .unwrap();
        Self(root)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn selected_app_project_uses_exact_ledger_id_and_combines_safe_signals() {
    let fixture = Fixture::new();
    let target = ProjectBriefingTarget {
        id: "app-alpha".into(),
        display_name: "App Alpha".into(),
        ledger_project_id: "ledger-alpha".into(),
        recent_session_titles: vec![" Recent topic ".into(), "Recent topic".into()],
    };
    let signals = read(
        &fixture.0,
        &LocaleCollation::new("en-US").unwrap(),
        Some(&[target]),
        &fixture.0.join("cognition/consolidation"),
    )
    .unwrap();
    assert_eq!(signals.len(), 1);
    let signal = &signals[0];
    assert_eq!(signal.id, "app-alpha");
    assert_eq!(signal.display_name, "App Alpha");
    assert_eq!(signal.summary.as_deref(), Some("Project summary"));
    assert_eq!(signal.recent_session_titles, vec!["Recent topic"]);
    assert_eq!(
        signal.ledger_event_summary,
        vec!["work.updated:in_progress x1"]
    );
    assert_eq!(signal.open_work_titles, vec!["Persona routing"]);
    assert_eq!(signal.completed_work_titles, vec!["Finished routing"]);
    assert_eq!(signal.excluded_topics, vec!["canary", "카나리"]);
}

#[test]
fn invalid_ledger_id_is_not_sanitized_into_another_project_path() {
    let fixture = Fixture::new();
    let target = ProjectBriefingTarget {
        id: "app-alpha".into(),
        display_name: "App Alpha".into(),
        ledger_project_id: "../ledger-alpha".into(),
        recent_session_titles: vec![],
    };
    let signals = read(
        &fixture.0,
        &LocaleCollation::new("en-US").unwrap(),
        Some(&[target]),
        &fixture.0.join("cognition/consolidation"),
    )
    .unwrap();
    assert_eq!(signals.len(), 1);
    assert!(signals[0].summary.is_none());
    assert!(signals[0].ledger_event_summary.is_empty());
    assert!(signals[0].open_work_titles.is_empty());
}
