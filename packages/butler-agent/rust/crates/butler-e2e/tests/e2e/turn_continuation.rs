//! General terminal conditions through the real model/tool/approval loop.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]

use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::{tool_rows, turn_state},
    scenario::{Access, Setup, accepted_turn_id},
};
use serde_json::json;
use std::time::Duration;

async fn setup(
    mode: stub::Mode,
    access: Access,
) -> Result<
    (
        butler_e2e::e2e::scenario::Scenario,
        std::sync::Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start(mode).await?;
    let mut setup = Setup::new("TURN-CONTINUATION")?
        .access(access)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    if matches!(mode, stub::Mode::Limit) {
        setup = setup
            .env("BUTLER_BOUNDED_STATELESS_CONTEXT", "1")
            .env("BUTLER_CONTINUATION_MAX_OUTPUT_BYTES", "1");
    }
    Ok((setup.start().await?, script, server))
}

#[tokio::test]
async fn checkpoint_open_disposition_and_progress_continue_until_work_is_done()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup(stub::Mode::Progress, Access::FullAccess).await?;
    let (id, turn) = s.turn("general", stub::REQUEST).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = script.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 9, "open progress ended the turn");
    assert!(
        requests[5]["tools"]
            .as_array()
            .is_some_and(|tools| !tools.is_empty()),
        "open disposition must retain working tools"
    );
    assert!(
        requests[6]
            .to_string()
            .contains("Only progress/bookkeeping is recorded")
    );
    assert!(
        requests[6]
            .to_string()
            .contains("Continue any unfinished work")
    );
    let messages = s.gw.messages("general").await?;
    assert!(
        tool_rows(&messages, &id)
            .iter()
            .any(|row| row["safe_tool_name"] == "run_command")
    );
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == "The total is 42.")
    );
    s.finish().await?;
    server.abort();
    super::steward_presentation::unfinished_disposition_delivers_failure().await?;
    Ok(())
}
#[tokio::test]
async fn reasoning_only_response_and_todo_updates_continue() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (mode, count) in [
        (stub::Mode::Reasoning, 2),
        (stub::Mode::Commentary, 2),
        (stub::Mode::Todo, 5),
    ] {
        let (s, script, server) = setup(mode, Access::FullAccess).await?;
        let (_, turn) = s.turn("general", stub::REQUEST).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        assert_eq!(script.requests.lock().unwrap().len(), count);
        let messages = s.gw.messages("general").await?;
        assert!(
            messages
                .iter()
                .any(|m| m["role"] == "assistant" && m["text"] == "The total is 42.")
        );
        if matches!(mode, stub::Mode::Todo) {
            let records =
                std::fs::read_dir(s.sandbox.data.join("todos"))?.collect::<Result<Vec<_>, _>>()?;
            assert_eq!(records.len(), 1, "TODO must be an ordinary record file");
            let todo: serde_json::Value =
                serde_json::from_slice(&std::fs::read(records[0].path())?)?;
            assert!(todo["list_id"].as_str().unwrap().ends_with(":main"));
            assert_eq!(todo["items"].as_array().unwrap().len(), 1);
            assert_eq!(todo["items"][0]["content"], "Calculate total");
            assert_eq!(todo["items"][0]["status"], "completed");
        }
        s.finish().await?;
        server.abort();
    }
    Ok(())
}
#[tokio::test]
async fn pending_approval_pauses_without_automatic_continuation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup(stub::Mode::Approval, Access::AskFirst).await?;
    let id = accepted_turn_id(&s.gw.say("general", stub::REQUEST).await?)?;
    let turn =
        s.gw.wait_turn(
            "general",
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    assert_eq!(script.requests.lock().unwrap().len(), 1);
    let cards = s.gw.approval_requests("general").await?;
    assert_eq!(cards.len(), 1);
    let reference = cards[0]["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202);
    let turn =
        s.gw.wait_terminal("general", &id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(script.requests.lock().unwrap().len(), 2);
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn pending_question_pauses_and_answer_resumes_same_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup(stub::Mode::Question, Access::FullAccess).await?;
    let id = accepted_turn_id(&s.gw.say("general", stub::REQUEST).await?)?;
    let paused =
        s.gw.wait_turn(
            "general",
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(turn_state(&paused), "waiting_for_form", "{paused}");
    assert_eq!(script.requests.lock().unwrap().len(), 1);
    let response = s.gw.get("/session-view?session_id=general").await?;
    let view = response.data();
    let reference = view["pending_questions"][0]["request_ref"]
        .as_str()
        .unwrap();
    let reply = s.gw.post(&format!("/authority-requests/{reference}/answer?session_id=general"),
        json!({"status":"answered","answers":[{"id":"format","selected":["brief"],"custom":null}]})).await?;
    assert_eq!(reply.status, 202);
    let done =
        s.gw.wait_terminal("general", &id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    assert_eq!(script.requests.lock().unwrap().len(), 2);
    let messages = s.gw.messages("general").await?;
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == "The total is 42.")
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn empty_recovery_and_budget_limit_report_honest_status() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for mode in [stub::Mode::Empty, stub::Mode::Prose, stub::Mode::Limit] {
        let (s, script, server) = setup(mode, Access::FullAccess).await?;
        let (_, turn) = s.turn("general", stub::REQUEST).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        let messages = s.gw.messages("general").await?;
        let answer = messages.iter().find(|m| m["role"] == "assistant").unwrap()["text"]
            .as_str()
            .unwrap();
        assert!(answer.contains("could not complete"), "{answer}");
        assert!(answer.contains("limit"), "{answer}");
        let requests = script.requests.lock().unwrap().clone();
        assert_eq!(
            requests.len(),
            if matches!(mode, stub::Mode::Limit) {
                1
            } else {
                4
            }
        );
        if matches!(mode, stub::Mode::Empty) {
            assert!(requests[3].to_string().contains("occurred 3 times"));
        }
        s.finish().await?;
        server.abort();
    }
    Ok(())
}

#[tokio::test]
async fn approval_resume_preserves_the_automatic_continuation_bound() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup(stub::Mode::ApprovalRecovery, Access::AskFirst).await?;
    let id = accepted_turn_id(&s.gw.say("general", stub::REQUEST).await?)?;
    let paused =
        s.gw.wait_turn(
            "general",
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(turn_state(&paused), "waiting_for_form");
    assert_eq!(script.requests.lock().unwrap().len(), 2);
    let cards = s.gw.approval_requests("general").await?;
    let reference = cards[0]["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202);
    let done =
        s.gw.wait_terminal("general", &id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered");
    assert_eq!(
        script.requests.lock().unwrap().len(),
        5,
        "approval reset the continuation counter"
    );
    let messages = s.gw.messages("general").await?;
    assert!(messages.iter().any(|m| {
        m["role"] == "assistant"
            && m["text"]
                .as_str()
                .is_some_and(|text| text.contains("automatic continuation limit"))
    }));
    s.finish().await?;
    server.abort();
    Ok(())
}

mod stub {
    use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
    use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
    use serde_json::{Value, json};
    use std::{
        fmt::Write,
        sync::{Arc, Mutex},
    };

    pub(super) const REQUEST: &str = "Calculate the total and report the result.";
    #[derive(Clone, Copy)]
    pub(super) enum Mode {
        Progress,
        Empty,
        Reasoning,
        Commentary,
        Approval,
        Question,
        Limit,
        Todo,
        Prose,
        ApprovalRecovery,
    }
    pub(super) struct Script {
        pub requests: Mutex<Vec<Value>>,
        pub mode: Mode,
    }

    pub(super) async fn start(
        mode: Mode,
    ) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}/codex", listener.local_addr()?);
        let script = Arc::new(Script {
            requests: Mutex::new(vec![]),
            mode,
        });
        let app = Router::new()
            .route("/codex/responses", post(reply))
            .with_state(script.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok((url, script, server))
    }
    async fn reply(
        State(script): State<Arc<Script>>,
        Json(body): Json<Value>,
    ) -> axum::response::Response {
        let key = matching::key("/codex/responses", &body, &Placeholders::default());
        let item = if key.user_request == REQUEST {
            let step = {
                let mut requests = script.requests.lock().unwrap();
                requests.push(body.clone());
                requests.len() - 1
            };
            match script.mode {
                Mode::Progress => progress(step, &body),
                Mode::Prose => {
                    message("<tool_call>call: read_file {requests:[{path:\"source\"}]}</tool_call>")
                }
                Mode::ApprovalRecovery if step == 1 => command(true),
                Mode::Empty | Mode::ApprovalRecovery => message(""),
                Mode::Reasoning if step == 0 => {
                    json!({"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"Need to calculate the result."}]})
                }
                Mode::Commentary if step == 0 => {
                    let mut item = message("I am working on the total.");
                    item["phase"] = json!("commentary");
                    item
                }
                Mode::Question if step == 0 => call(
                    "question",
                    "ask_user",
                    &json!({"questions":[{"id":"format","eyebrow":"Output","title":"Which format?","kind":"single","allow_custom":true,"options":[{"id":"brief","label":"Brief","recommended":true},{"id":"full","label":"Full"}]}]}),
                ),
                Mode::Approval | Mode::Limit if step == 0 => {
                    command(matches!(script.mode, Mode::Approval))
                }
                Mode::Approval
                | Mode::Question
                | Mode::Limit
                | Mode::Reasoning
                | Mode::Commentary => message("The total is 42."),
                Mode::Todo => match step {
                    0 => call(
                        "todo",
                        "update_todo_list",
                        &json!({"todos":[{"content":"Calculate total","active_form":"Calculating total","status":"in_progress"}]}),
                    ),
                    1 => message("Progress updated. I will continue the calculation."),
                    2 => command(false),
                    3 => call(
                        "todo-done",
                        "update_todo_list",
                        &json!({"todos":[{"content":"Calculate total","active_form":"Calculating total","status":"completed"}]}),
                    ),
                    _ => message("The total is 42."),
                },
            }
        } else {
            message("{}")
        };
        ([("content-type", "text/event-stream")], wire(&item)).into_response()
    }
    fn progress(step: usize, body: &Value) -> Value {
        match step {
            0 => call("start", "start_work", &json!({"objective":REQUEST})),
            1 => call(
                "plan",
                "replace_work_plan",
                &json!({"objective":REQUEST,"execution_mode":"direct","actions":[{"action_key":"calculate","description":"Calculate the total"}],"checks":["Correct total reported"]}),
            ),
            2 => call(
                "review",
                "record_work_review",
                &json!({"subject":"plan","verdict":"accept","summary":"Plan covers the request"}),
            ),
            3 => call(
                "checkpoint",
                "record_work_checkpoint",
                &json!({"public_summary":"Calculation pending","action_updates":[{"action_key":"calculate","status":"active"}]}),
            ),
            4 => call(
                "open",
                "record_work_disposition",
                &json!({"work_id":work_id(body),"disposition":"open","summary":"Plan saved; calculation remains","action_updates":[],"remaining_actions":["calculate"],"next_condition":"Continue calculation","followups":[]}),
            ),
            5 => message("Progress saved; the calculation is still pending."),
            6 => command(false),
            7 => call(
                "complete",
                "record_work_disposition",
                &json!({"work_id":work_id(body),"disposition":"completed","summary":"Total verified","action_updates":[{"action_key":"calculate","status":"done"}],"remaining_actions":[],"followups":[]}),
            ),
            _ => message("The total is 42."),
        }
    }
    fn work_id(body: &Value) -> String {
        body["input"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .filter_map(|item| item["output"].as_str())
            .filter_map(|text| serde_json::from_str::<Value>(text).ok())
            .find_map(|output| {
                output
                    .pointer("/output/work/work_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap()
    }
    fn command(approval: bool) -> Value {
        let command = match (butler_platform::command_sandbox::POSIX_SHELL, approval) {
            (true, false) => "printf '%s\\n' $((19 + 23))",
            (true, true) => "printf '%s\\n' $((19 + 23)) > total.txt",
            (false, false) => "cmd.exe /d /c echo 42",
            (false, true) => "cmd.exe /d /c \"echo 42>total.txt\"",
        };
        call(
            "calculate",
            "run_command",
            &json!({"command":command,"summary":"Calculate total","state_effect":if approval { "mutation" } else { "read_only" },"timeout_ms":30000}),
        )
    }
    fn call(id: &str, name: &str, args: &Value) -> Value {
        json!({"type":"function_call","id":format!("fc_{id}"),"call_id":format!("call_{id}"),"name":name,"arguments":args.to_string(),"status":"completed"})
    }
    fn message(text: &str) -> Value {
        json!({"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
    }
    fn wire(item: &Value) -> String {
        let mut events = vec![
            json!({"type":"response.created","response":{"id":"resp_1","status":"in_progress","output":[]}}),
            json!({"type":"response.output_item.added","output_index":0,"item":item}),
        ];
        if item["type"] == "function_call" {
            events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}));
            events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}));
        } else if item["type"] == "message" {
            events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":item["content"][0]["text"]}));
        }
        events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
        events.push(json!({"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-6-sol","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
        let mut wire = String::new();
        for (i, mut event) in events.into_iter().enumerate() {
            event["sequence_number"] = json!(i);
            write!(
                wire,
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
            .unwrap();
        }
        wire
    }
}
