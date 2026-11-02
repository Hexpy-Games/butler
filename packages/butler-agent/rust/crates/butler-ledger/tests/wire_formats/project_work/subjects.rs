//! A separate format pin for registered subjects; the legacy case stays intact.
use super::super::golden::Normalizer;
use super::*;
use butler_turn::btcc::{PlanSubject, WorkPlan};
use serde_json::{Value, json};

pub(crate) async fn project_work_keeps_subjects() {
    let mut h = Harness::new("work-subjects");
    h.init().await;
    let fixture = TestStorageFixture::activated();
    let runtime = runtime(&fixture).await;
    let work = ProjectWork::new(h.ledger.clone(), runtime.clone(), runtime.clone(), runtime);
    let repo = work.repository(h.scope());
    let started = repo
        .start_work(start_command("turn-1", "start-subjects", "Research"))
        .await
        .unwrap();
    let mut command = plan_command(Plan {
        turn: "turn-1",
        call: "plan-subjects",
        objective: "Research sources",
        actions: vec![action("read", "Read sources", &[])],
        progress: progress(&[("read", ActionStatus::Pending)]),
        expected_work_id: Some(started.work_id),
        opening_plan: true,
    });
    let subjects = vec![PlanSubject {
        key: "source".into(),
        label: "Source".into(),
    }];
    command.input.subjects = subjects.clone();
    let planned = repo
        .replace_plan(command)
        .await
        .unwrap()
        .current_plan
        .unwrap();
    let loaded = repo
        .load_context(turn("turn-1"))
        .await
        .unwrap()
        .unwrap()
        .work
        .current_plan
        .unwrap();
    assert_eq!(planned, loaded);
    assert_eq!(loaded.subjects, subjects);
    let value = serde_json::to_value(&loaded).unwrap();
    assert_eq!(
        value["subjects"],
        json!([{"key":"source", "label":"Source"}])
    );
    assert_eq!(
        serde_json::from_value::<WorkPlan>(value.clone()).unwrap(),
        loaded
    );
    assert!(format!("{loaded:?}").contains("subjects"));
    optional_subjects(&loaded);
    let stored = std::fs::read_to_string(
        h.root
            .join("plans")
            .join(format!("{}.md", loaded.plan_revision_id)),
    )
    .unwrap();
    let mut normalizer = Normalizer::new(h.data());
    let golden = format!(
        "=== stored plan with subjects\n{}\n=== loaded plan with subjects\n{}\n",
        normalizer.text(&stored),
        normalizer.json(&value)
    );
    work.close().await;
    h.ledger.close().await;
    assert_golden("project_work_subjects.txt", &golden);
}

fn optional_subjects(plan: &WorkPlan) {
    let mut empty = plan.clone();
    empty.subjects.clear();
    let legacy = serde_json::to_value(&empty).unwrap();
    assert!(legacy.get("subjects").is_none());
    assert!(!format!("{empty:?}").contains("subjects"));
    for subjects in [None, Some(Value::Null), Some(json!([]))] {
        let mut raw = legacy.clone();
        if let Some(subjects) = subjects {
            raw["subjects"] = subjects;
        }
        assert_eq!(serde_json::from_value::<WorkPlan>(raw).unwrap(), empty);
    }
    for subjects in [json!("source"), json!([{}])] {
        let mut raw = legacy.clone();
        raw["subjects"] = subjects;
        assert!(serde_json::from_value::<WorkPlan>(raw).is_err());
    }
}
