use super::{recursive, work_model::*};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use butler_platform::sqlite;
use serde_json::{Value, json};

fn request(instruction: &str, key: &str, graph: u64, command: Value) -> Value {
    let mut value =
        json!({"instruction_id":instruction,"idempotency_key":key,"expected_graph_revision":graph});
    value
        .as_object_mut()
        .unwrap()
        .insert("command".into(), command);
    value
}

pub(super) async fn sparse_graph() -> Result<(), HarnessError> {
    let (s, instruction) = setup("WM-09-SPARSE").await?;
    assert_eq!(apply(&s, light(&instruction)).await?["ok"], true);
    let before = summary(&s).await?;
    let tasks = before["tasks"].as_array().unwrap();
    let a = tasks[0]["id"].as_str().unwrap();
    let b = tasks[1]["id"].as_str().unwrap();
    let join = tasks[2]["id"].as_str().unwrap();
    let remove = json!({"op":"remove","task_id":a,"expected_revision":1});
    assert_eq!(
        apply(&s, request(&instruction, "implicit-remove", 1, remove)).await?["error"]["code"],
        "successor_rewiring_required"
    );
    let cycle = json!({"op":"dependencies","add":[{"from":join,"to":b}],"remove":[]});
    assert_eq!(
        apply(&s, request(&instruction, "cycle", 1, cycle)).await?["error"]["code"],
        "dependency_cycle"
    );
    let foreign =
        json!({"op":"dependencies","add":[{"from":"foreign-plan-task","to":b}],"remove":[]});
    assert_eq!(
        apply(&s, request(&instruction, "foreign", 1, foreign)).await?["error"]["code"],
        "task_scope_invalid"
    );
    let remove = json!({"op":"remove","task_id":a,"expected_revision":1,"remove_edges":[{"from":a,"to":join}]});
    assert_eq!(
        apply(&s, request(&instruction, "explicit-remove", 1, remove)).await?["ok"],
        true
    );
    let after = summary(&s).await?;
    assert_eq!(after["total"], 3);
    assert_eq!(after["counts"]["cancelled"], 1);
    assert_eq!(after["tasks"][0]["id"], a);
    assert_eq!(after["tasks"][0]["status"], "cancelled");
    let step = json!({"op":"step","task_id":join,"phase":"execution"});
    assert_eq!(
        apply(&s, request(&instruction, "join-step", 2, step)).await?["error"]["code"],
        "prerequisite_unmet"
    );
    let graph = s.gw.get("/sessions/general/task-graph").await?;
    assert_eq!(graph.data()["edge_total"], 1);
    assert_eq!(graph.data()["edges"], json!([{"from":b,"to":join}]));
    s.finish().await
}

pub(super) async fn research_review() -> Result<(), HarnessError> {
    let (s, instruction) = setup("WM-15-RESEARCH").await?;
    let mut bundle = recursive::bundle(3);
    bundle["nodes"].as_array_mut().unwrap().truncate(1);
    bundle["works"].as_array_mut().unwrap().truncate(1);
    bundle["tasks"].as_array_mut().unwrap().truncate(1);
    bundle["nodes"][0]["kind"] = json!("research");
    bundle["nodes"][0]["research_method"] = json!({"questions":["Does treatment improve response?"],"hypotheses":["Treatment improves response"],"method":"Run preregistered experiment and retain null results","variables_controls":"Treatment versus control with fixed seed","sampling_sources":"100 observations per group","analysis":"Report estimated difference and confidence interval","falsification":"No improvement is a valid null result"});
    bundle["nodes"][0]["criteria"] = json!([
        {"id":"AC","part_id":"API","text":"Run and report the complete predefined method including null results","verification":"Retained experiment log"},
        {"id":"HYPOTHESIS","part_id":"API","text":"Evidence supports an improvement","verification":"Positive confidence interval"}]);
    bundle["works"][0]["criterion_ids"] = json!(["AC", "HYPOTHESIS"]);
    let created = apply(
        &s,
        request(
            &instruction,
            "research",
            1,
            json!({"op":"create","bundle":bundle}),
        ),
    )
    .await?;
    assert_eq!(created["ok"], true, "{created}");
    let view = summary(&s).await?;
    let id = view["tasks"][0]["id"].as_str().unwrap();
    let mut revision = 1;
    for (round, verdict) in ["unverified", "fail", "pass"].iter().enumerate() {
        let start = json!({"op":"start","task_id":id,"expected_revision":revision});
        assert_eq!(
            apply(
                &s,
                request(&instruction, &format!("start-{round}"), 1, start)
            )
            .await?["ok"],
            true
        );
        revision += 1;
        let submit = json!({"op":"submit","task_id":id,"expected_revision":revision,"result_refs":["artifact:null-result"],"evidence_refs":["experiment:complete"]});
        assert_eq!(
            apply(
                &s,
                request(&instruction, &format!("submit-{round}"), 1, submit)
            )
            .await?["ok"],
            true
        );
        revision += 1;
        let missing = json!({"op":"review","task_id":id,"expected_revision":revision,"result_revision":round+1,"criterion_results":[]});
        assert_eq!(
            apply(
                &s,
                request(&instruction, &format!("missing-{round}"), 1, missing)
            )
            .await?["error"]["code"],
            "criterion_review_required"
        );
        let stale = json!({"op":"review","task_id":id,"expected_revision":revision,"result_revision":0,"criterion_results":[]});
        assert_eq!(
            apply(
                &s,
                request(&instruction, &format!("stale-{round}"), 1, stale)
            )
            .await?["error"]["code"],
            "result_revision_conflict"
        );
        let review = json!({"op":"review","task_id":id,"expected_revision":revision,"result_revision":round+1,"criterion_results":[{"criterion_id":"AC","verdict":verdict,"evidence_refs":["experiment:complete"],"reason":"Method complete; estimate is null, hypothesis remains unsupported"}]});
        let receipt = apply(
            &s,
            request(&instruction, &format!("review-{round}"), 1, review),
        )
        .await?;
        assert_eq!(receipt["ok"], true, "{receipt}");
        revision += 1;
        if *verdict != "pass" {
            assert_eq!(receipt["task"]["status"], "pending");
            assert_eq!(
                receipt["task"]["result_refs"],
                json!(["artifact:null-result"])
            );
        }
    }
    let complete = json!({"op":"complete","task_id":id,"expected_revision":revision});
    assert_eq!(
        apply(&s, request(&instruction, "complete", 1, complete)).await?["ok"],
        true
    );
    let work = view["tasks"][0]["work_id"].clone();
    let aggregate = json!({"op":"complete_work","work_id":work});
    assert_eq!(
        apply(
            &s,
            request(&instruction, "unproved-hypothesis", 1, aggregate)
        )
        .await?["error"]["code"],
        "criterion_coverage_incomplete"
    );
    let db = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM wm_results", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM wm_reviews WHERE accepted=0",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    s.finish().await
}

pub(super) async fn publication_recovery() -> Result<(), HarnessError> {
    let (mut s, instruction) = setup("WM-08-PUBLICATION-RECOVERY").await?;
    let input = light(&instruction);
    let first = apply(&s, input.clone()).await?;
    assert_eq!(first["ok"], true);
    let original = summary(&s).await?;
    s.agent.terminate().await?;
    {
        let db = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
        // Crash image: immutable publication is committed; SQLite activation/receipt is absent.
        db.execute_batch("BEGIN; DELETE FROM wm_outbox; DELETE FROM wm_audit; DELETE FROM wm_coverage; DELETE FROM wm_edges; DELETE FROM wm_task_criteria; DELETE FROM wm_tasks; DELETE FROM wm_works; DELETE FROM wm_tree; DELETE FROM wm_sessions; DELETE FROM wm_counts; DELETE FROM wm_plans; DELETE FROM wm_criteria; DELETE FROM wm_parts; DELETE FROM wm_specs; UPDATE wm_intents SET receipt_json=NULL; COMMIT; PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        let request: String = db
            .query_row("SELECT request_json FROM wm_intents", [], |r| r.get(0))
            .unwrap();
        assert!(
            !request.contains("Files are sorted"),
            "Spec prose duplicated in SQLite intent"
        );
    }
    s.gw = s.agent.start_again().await?;
    let recovered = summary(&s).await?;
    assert_eq!(recovered["plan_id"], original["plan_id"]);
    assert_eq!(recovered["tasks"], original["tasks"]);
    assert_eq!(recovered["root_spec_ref"], original["root_spec_ref"]);
    let receipt = apply(&s, input).await?;
    assert_eq!(receipt["plan_id"], first["plan_id"]);
    assert_eq!(receipt["published_refs"], first["published_refs"]);
    let db = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM wm_plans", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM wm_audit WHERE json_type(request_json,'$.command') IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM wm_instructions i JOIN wm_audit a ON a.seq=json_extract(i.receipt_json,'$.event_seq') JOIN wm_outbox o ON o.seq=a.seq WHERE i.status='applied' AND a.instruction_id=i.id AND json_extract(o.event_json,'$.receipt.status')='applied' AND json_extract(o.event_json,'$.receipt.operation_count')=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    s.restart().await?;
    assert_eq!(summary(&s).await?, recovered);
    s.finish().await
}

pub(super) async fn opt_in_fence() -> Result<(), HarnessError> {
    let mut legacy = Setup::new("WM-EMPTY-FENCE")?
        .stub_cassette(Cassette::load("TURN-02")?)
        .start()
        .await?;
    legacy
        .turn("general", "Reply with exactly the word: once")
        .await?;
    legacy.agent.terminate().await?;
    legacy
        .agent
        .launch
        .env
        .push(("BUTLER_WORK_MODEL".into(), "core".into()));
    assert!(
        legacy.agent.start_again().await.is_err(),
        "Existing history enabled without migration"
    );
    let db = sqlite::open(legacy.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='wm_mode'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    legacy.finish().await?;
    let (mut core, instruction) = setup("WM-DOWNGRADE-FENCE").await?;
    assert_eq!(apply(&core, light(&instruction)).await?["ok"], true);
    core.agent.terminate().await?;
    core.agent
        .launch
        .env
        .retain(|(name, _)| name != "BUTLER_WORK_MODEL");
    assert!(
        core.agent.start_again().await.is_err(),
        "Legacy writer resumed a managed installation"
    );
    core.finish().await
}
