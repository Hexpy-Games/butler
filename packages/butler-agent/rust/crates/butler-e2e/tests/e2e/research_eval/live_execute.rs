use super::{fixture::Task, live_proxy::Proxy};
use butler_e2e::e2e::{
    HarnessError,
    config::LiveProvider,
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) struct Outcome {
    pub status: String,
    pub answer: String,
    pub host_reads: usize,
    pub asks_answered: usize,
    pub approvals_given: usize,
    pub error: Option<String>,
}

pub(super) async fn execute(
    mut provider: LiveProvider,
    task: Arc<Task>,
    proxy: &Proxy,
) -> Result<Outcome, HarnessError> {
    provider.base_url = Some(proxy.base.clone());
    let setup = Setup::new("RESEARCH-EVAL-LIVE")?
        .live(provider)
        .access(Access::AskExceptReads)
        .env("BUTLER_BRAVE_SEARCH_API_KEY", "offline-fixture-key")
        .env("BUTLER_WEB_READER_BACKEND", "browser")
        .env("HTTP_PROXY", &proxy.sink)
        .env("HTTPS_PROXY", &proxy.sink)
        .env("ALL_PROXY", &proxy.sink)
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("http_proxy", &proxy.sink)
        .env("https_proxy", &proxy.sink)
        .env("all_proxy", &proxy.sink)
        .env("no_proxy", "127.0.0.1,localhost");
    // Command tools filter inherited proxy variables; their login shell reads
    // this private fixture profile and restores the same offline sink.
    let sink = &proxy.sink;
    let profile = format!(
        "export HTTP_PROXY='{sink}' HTTPS_PROXY='{sink}' ALL_PROXY='{sink}' http_proxy='{sink}' https_proxy='{sink}' all_proxy='{sink}' NO_PROXY='127.0.0.1,localhost' no_proxy='127.0.0.1,localhost'\n"
    );
    tokio::fs::write(setup.sandbox.home.join(".profile"), profile).await?;
    let mut s = setup.start().await?;
    let result = drive(&s, task, proxy).await;
    // Always tear down, including failed/blind tasks: no retained answer logs.
    s.sandbox.mark_success();
    let finish = s.finish().await;
    match (result, finish) {
        (Ok(outcome), Ok(())) => Ok(outcome),
        (Err(error), _) | (_, Err(error)) => Err(error),
    }
}

async fn drive(s: &Scenario, task: Arc<Task>, proxy: &Proxy) -> Result<Outcome, HarnessError> {
    super::run::configure_search(s, &proxy.base, true).await?;
    let mut browser = super::live_browser::start(s, &task, proxy).await?;
    proxy.traffic.lock().unwrap().last_request = Instant::now();
    s.gw.say_turn("general", task.spec["request"].as_str().unwrap())
        .await?;
    let mut outcome = tokio::select! {
        result = wait(s, proxy) => result?,
        () = browser.wait() => return Err(HarnessError("snapshot App host exited during the task".into())),
    };
    outcome.host_reads = proxy.traffic.lock().unwrap().snapshot_reads;
    Ok(outcome)
}
/// A delegation ends its admission turn before the result starts a new Butler turn.
/// Wait for execution, queued deliveries and each child result's parent turn.
pub(super) async fn wait(s: &Scenario, proxy: &Proxy) -> Result<Outcome, HarnessError> {
    let mut interactions = super::live_interactions::Interactions::default();
    loop {
        let (stopped, inactive, metered, wrong_model, runaway) = {
            let traffic = proxy.traffic.lock().unwrap();
            (
                traffic.stopped,
                traffic.last_request.elapsed() >= Duration::from_secs(300),
                traffic.requests.iter().all(super::live_usage::accounted),
                traffic.rejected_model_requests > 0,
                traffic.budget.runaway,
            )
        };
        let can_continue = if stopped || inactive || wrong_model || runaway {
            true
        } else {
            interactions.respond(&s.gw).await?
        };
        let turns = s.gw.turns("general").await?;
        let latest = turns.last().cloned().unwrap_or(Value::Null);
        let state = latest["state"].as_str().unwrap_or_default();
        let view = s.gw.get("/session-view?session_id=general").await?;
        let work = s.gw.get("/user-work").await?;
        let settled = work.data()["classification"] == "no_active_work"
            && delegations_delivered(view.data(), &turns);
        let messages = s.gw.messages("general").await?;
        let mut answer = final_answer(&messages, &latest);
        if runaway && answer.is_empty() {
            answer = messages
                .iter()
                .filter(|m| m["role"] == "assistant")
                .map(public_text)
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
        }
        let status = if stopped {
            Some("stopped_spend_guard")
        } else if runaway {
            Some("runaway")
        } else if !can_continue {
            Some("stuck_on_ask")
        } else if inactive || wrong_model {
            Some("incomplete")
        } else if settled && metered && state == "delivered" && !answer.is_empty() {
            Some("complete")
        } else if settled && matches!(state, "failed" | "cancelled" | "runtime_fault") {
            Some("incomplete")
        } else {
            None
        };
        if let Some(status) = status {
            return Ok(Outcome {
                status: status.into(),
                answer,
                host_reads: 0,
                asks_answered: interactions.asks,
                approvals_given: interactions.approvals,
                error: (status == "incomplete")
                    .then(|| json!({"inactive":inactive,"turn":latest}).to_string()),
            });
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
fn delegations_delivered(view: &Value, turns: &[Value]) -> bool {
    view["steward_children"]
        .as_array()
        .into_iter()
        .flatten()
        .all(|child| {
            let result = &child["result"]["result_id"];
            result.is_string()
                && turns.iter().any(|turn| {
                    turn["state"] == "delivered"
                        && turn["execution_controls"]["subsession_result"]["result_id"] == *result
                })
        })
}
fn final_answer(messages: &[Value], turn: &Value) -> String {
    let id = butler_e2e::e2e::gateway::turn_id_of(turn);
    messages
        .iter()
        .filter(|m| {
            m["role"] == "assistant" && m["status"] == "delivered" && m["turn_id"].as_str() == id
        })
        .map(public_text)
        .collect::<Vec<_>>()
        .join("\n")
}

fn public_text(message: &Value) -> String {
    let mut text = message["text"].as_str().unwrap_or_default().to_owned();
    if message["answer_blocks"]
        .as_array()
        .is_some_and(|a| !a.is_empty())
    {
        text.push_str(&format!("\n{}", message["answer_blocks"]));
    }
    text
}
