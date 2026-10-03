use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};

pub(super) async fn setup(id: &str) -> Result<(Scenario, String), HarnessError> {
    let s = Setup::new(id)?
        .env("BUTLER_WORK_MODEL", "core")
        .stub_cassette(Cassette::load("TURN-02")?)
        .start()
        .await?;
    let (turn, _) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    Ok((s, turn))
}

pub(super) fn light(instruction: &str) -> Value {
    json!({"instruction_id":instruction,"idempotency_key":"bootstrap","command":{
        "op":"create_light","goal":"Organise Downloads","done_criteria":[
            {"id":"AC-SORT","text":"Files are sorted by type"},
            {"id":"AC-VERIFY","text":"No files are lost"}],
        "tasks":[
            {"key":"sort-a","description":"Sort documents","criterion_ids":["AC-SORT"]},
            {"key":"sort-b","description":"Sort images","criterion_ids":["AC-SORT"]},
            {"key":"join","description":"Verify all files","criterion_ids":["AC-VERIFY"],
                "after":["sort-a","sort-b"],"kind":"integrate"}]
    }})
}

pub(super) async fn apply(s: &Scenario, input: Value) -> Result<Value, HarnessError> {
    let reply = s.gw.post("/sessions/general/work-model", input).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}

pub(super) async fn summary(s: &Scenario) -> Result<Value, HarnessError> {
    let reply = s.gw.get("/sessions/general/work-summary").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}

pub(super) async fn review_and_join() -> Result<(), HarnessError> {
    let (s, instruction) = setup("WM-15").await?;
    let created = apply(&s, light(&instruction)).await?;
    assert_eq!(created["ok"], true, "{created}");
    let view = summary(&s).await?;
    let tasks = view["tasks"].as_array().unwrap();
    let join = tasks[2]["id"].as_str().unwrap();
    let request = |key: &str, command: Value| {
        json!({"instruction_id":instruction,
        "idempotency_key":key,"expected_graph_revision":1,"command":command})
    };
    let rejected = apply(
        &s,
        request(
            "join-early",
            json!({"op":"start","task_id":join,"expected_revision":1}),
        ),
    )
    .await?;
    assert_eq!(rejected["error"]["code"], "prerequisite_unmet");
    for (index, task) in tasks[..2].iter().enumerate() {
        let id = task["id"].as_str().unwrap();
        let command = |op: &str, rev: u64| json!({"op":op,"task_id":id,"expected_revision":rev});
        assert_eq!(
            apply(&s, request(&format!("start-{index}"), command("start", 1))).await?["ok"],
            true
        );
        let mut submit = command("submit", 2);
        submit["result_refs"] = json!(["artifact:sorted"]);
        submit["evidence_refs"] = json!(["test:all-files"]);
        assert_eq!(
            apply(&s, request(&format!("submit-{index}"), submit)).await?["ok"],
            true
        );
        let missing = apply(
            &s,
            request(&format!("complete-{index}-early"), command("complete", 3)),
        )
        .await?;
        assert_eq!(missing["error"]["code"], "criterion_review_required");
        let mut review = command("review", 3);
        review["result_revision"] = json!(1);
        review["criterion_results"] = json!([{"criterion_id":"AC-SORT","verdict":"pass","evidence_refs":["test:all-files"],"reason":"all files retained"}]);
        assert_eq!(
            apply(&s, request(&format!("review-{index}"), review)).await?["ok"],
            true
        );
        assert_eq!(
            apply(
                &s,
                request(&format!("complete-{index}"), command("complete", 4))
            )
            .await?["ok"],
            true
        );
        let removed = apply(
            &s,
            request(&format!("remove-{index}"), command("remove", 5)),
        )
        .await?;
        assert_eq!(removed["error"]["code"], "completed_task_immutable");
    }
    assert_eq!(
        apply(
            &s,
            request(
                "join-start",
                json!({"op":"start","task_id":join,"expected_revision":1})
            )
        )
        .await?["ok"],
        true
    );
    let latest = summary(&s).await?;
    assert_eq!(latest["counts"]["completed"], 2);
    assert_eq!(latest["counts"]["running"], 1);
    assert_eq!(latest["total"], 3);
    complete_join_and_next_goal(&s, &instruction, join, &latest).await?;
    s.finish().await
}

async fn complete_join_and_next_goal(
    s: &Scenario,
    instruction: &str,
    join: &str,
    latest: &Value,
) -> Result<(), HarnessError> {
    let request = |key: &str, command: Value| json!({"instruction_id":instruction,"idempotency_key":key,"expected_graph_revision":1,"command":command});
    let commands = [
        json!({"op":"submit","task_id":join,"expected_revision":2,"result_refs":["artifact:joined"],"evidence_refs":["test:join"]}),
        json!({"op":"review","task_id":join,"expected_revision":3,"result_revision":1,"criterion_results":[{"criterion_id":"AC-VERIFY","verdict":"pass","evidence_refs":["test:join"],"reason":"All fan-out results verified together"}]}),
        json!({"op":"complete","task_id":join,"expected_revision":4}),
        json!({"op":"complete_work","work_id":latest["works"][0]["id"]}),
        json!({"op":"complete_plan"}),
    ];
    for (i, command) in commands.into_iter().enumerate() {
        let result = apply(s, request(&format!("finish-{i}"), command)).await?;
        assert_eq!(result["ok"], true, "{result}");
    }
    let complete = summary(s).await?;
    assert_eq!(complete["status"], "completed");
    assert_eq!(complete["counts"]["completed"], 3);
    let mut next = light(instruction);
    next["idempotency_key"] = json!("new-goal");
    next["command"]["goal"] = json!("Organise another folder");
    assert_eq!(apply(s, next).await?["ok"], true);
    let next = summary(s).await?;
    assert_ne!(next["plan_id"], complete["plan_id"]);
    assert_ne!(next["root_spec_ref"], complete["root_spec_ref"]);
    let path = format!(
        "/plans/{}/task-graph",
        complete["plan_id"].as_str().unwrap()
    );
    let old = s.gw.get(&path).await?;
    assert_eq!(old.status, 200, "{}", old.text);
    assert_eq!(old.data()["plan_id"], complete["plan_id"]);
    assert_eq!(old.data()["counts"]["completed"], 3);
    assert_eq!(old.data()["tasks"], complete["tasks"]);
    assert_eq!(old.data()["current_task_id"], Value::Null);
    Ok(())
}

pub(super) async fn invalid_creation() -> Result<(), HarnessError> {
    let (s, instruction) = setup("WM-01").await?;
    let invalid =
        s.gw.get("/sessions/general/work-summary?revision=invalid")
            .await?;
    assert_eq!(
        invalid.data()["error"]["code"],
        "work_model_revision_invalid"
    );
    let mut input = light(&instruction);
    input["command"]["tasks"][0]["after"] = json!(["join"]);
    assert_eq!(apply(&s, input).await?["error"]["code"], "dependency_cycle");
    assert_eq!(summary(&s).await?["total"], 0);
    let mut input = light(&instruction);
    input["idempotency_key"] = json!("bad-criterion");
    input["command"]["tasks"][0]["criterion_ids"] = json!(["missing"]);
    assert_eq!(
        apply(&s, input).await?["error"]["code"],
        "criterion_binding_invalid"
    );
    assert_eq!(summary(&s).await?["total"], 0);
    s.finish().await
}
