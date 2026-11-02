use super::{
    diag,
    fixture::{Fixture, Task},
    policy::Policy,
    report,
};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    config::ModelChoice,
    scenario::{Scenario, Setup},
    security::AdminClient,
};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};

pub(super) async fn task(task: Arc<Task>, set: &str, out: &Path) -> Result<Value, HarnessError> {
    let fixture = match Fixture::start(task.clone()).await {
        Ok(fixture) => fixture,
        Err(error) => {
            return result(
                &task,
                set,
                out,
                &Policy::new(task.clone()),
                &Value::Null,
                Some(error.to_string()),
            )
            .await;
        }
    };
    let mut terminal = Value::Null;
    let mut error = execute(&fixture, &task, &mut terminal)
        .await
        .err()
        .map(|e| e.to_string());
    let captured = {
        let state = fixture.state.lock().unwrap();
        (state.snapshot(), state.answer.clone())
    };
    if !super::blind(set) {
        let row = json!({"status":if error.is_none(){"complete"}else{"incomplete"},
            "last_lane_state":captured.0,"terminal":terminal,"error":error});
        let tail = {
            let state = fixture.state.lock().unwrap();
            diag::tail(&state, &row)
        };
        if let Err(failure) = diag::save_tail(&task, set, out, tail).await {
            error = Some(format!(
                "{}; diagnostics: {failure}",
                error.unwrap_or_default()
            ));
        }
    }
    // Measure and serialize on a blocking thread; keep the task fixture alive.
    let state = fixture.state.clone();
    let task_copy = task.clone();
    let set_copy = set.to_owned();
    let mut row = tokio::task::spawn_blocking(move || {
        let state = state.lock().unwrap();
        let answer = captured.1.unwrap_or_else(|| state.butler_view());
        let mut row = report::measure(&task_copy, &set_copy, &state, &answer)?;
        report::outcome(&mut row, &captured.0, &terminal, error.as_deref());
        Ok::<_, HarnessError>(row)
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    if let Some(directory) = diag::directory(&task, set) {
        let captured = {
            let state = fixture.state.lock().unwrap();
            json!({"exchanges":state.exchanges,"answer":state.answer,"row":row})
        };
        if let Err(error) = diag::save(&task, directory, captured).await {
            row["status"] = json!("incomplete");
            row["completed"] = json!(false);
            row["diagnostic_error"] = json!(error.to_string());
        }
    }
    Ok(row)
}
async fn result(
    task: &Task,
    set: &str,
    out: &Path,
    state: &Policy,
    terminal: &Value,
    error: Option<String>,
) -> Result<Value, HarnessError> {
    let mut row = report::measure(task, set, state, &state.butler_view())?;
    report::outcome(&mut row, &state.snapshot(), terminal, error.as_deref());
    if !super::blind(set) {
        diag::save_tail(task, set, out, diag::tail(state, &row)).await?;
    }
    Ok(row)
}
async fn execute(fixture: &Fixture, task: &Task, terminal: &mut Value) -> Result<(), HarnessError> {
    let s = Setup::new("RESEARCH-EVAL")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env(
            "BUTLER_CHATGPT_API_BASE_URL",
            format!("{}/v1", fixture.base),
        )
        .env("BUTLER_BRAVE_SEARCH_API_KEY", "offline-fixture-key")
        .start()
        .await?;
    let result = drive(&s, fixture, task, terminal).await;
    if result.is_err() {
        terminal["deadline_snapshot"] = fixture.state.lock().unwrap().snapshot();
        terminal["turns_at_failure"] = json!(s.gw.turns("general").await.unwrap_or_default());
        terminal["messages_at_failure"] = json!(s.gw.messages("general").await.unwrap_or_default());
    }
    let finish = s.finish().await;
    result.and(finish)
}
async fn drive(
    s: &Scenario,
    fixture: &Fixture,
    task: &Task,
    terminal: &mut Value,
) -> Result<(), HarnessError> {
    s.select_model(&ModelChoice::parse("openai/gpt-6.1-sol@low").unwrap())
        .await?;
    s.patch_settings(
        json!({"browser":{"browsing_agent":"off"}}),
        "direct browser tools",
    )
    .await?;
    configure_search(s, &fixture.base, false).await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let browser_task = fixture.state.lock().unwrap().task.clone();
    let browser = super::host::Host::attach(admin, browser_task, false).await?;
    let _served = browser.start();
    let (turn_id, turn) = s
        .turn("general", task.spec["request"].as_str().unwrap())
        .await?;
    *terminal = json!({"turn_id":turn_id,"turn":turn});
    wait_for_answer(s, fixture).await
}
async fn wait_for_answer(s: &Scenario, fixture: &Fixture) -> Result<(), HarnessError> {
    let mut idle = IdleWait::new(fixture.state.lock().unwrap().exchanges.len());
    loop {
        let (answer, received) = {
            let state = fixture.state.lock().unwrap();
            (state.answer.clone(), state.exchanges.len())
        };
        let expired = idle.expired(received, tokio::time::Instant::now());
        if let Some(answer) = answer
            && s.gw
                .messages("general")
                .await?
                .iter()
                .any(|m| m["text"] == answer)
        {
            return Ok(());
        }
        if expired {
            return Err(HarnessError(
                "research task inactive for 120s without a final answer".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub(super) async fn configure_search(
    s: &Scenario,
    base: &str,
    planning: bool,
) -> Result<(), HarnessError> {
    let path = s.sandbox.data.join("butler.config.json");
    let base = base.to_owned();
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        config["webSearch"] = json!({"provider":"brave", "readerBackend":"browser", "planning":{"enabled":planning},
            "braveApiBase":format!("{base}/search")});
        std::fs::write(path, serde_json::to_vec(&config)?)?;
        Ok(())
    }).await.map_err(|e|HarnessError(e.to_string()))?
}

struct IdleWait {
    calls: usize,
    deadline: tokio::time::Instant,
}
impl IdleWait {
    fn new(calls: usize) -> Self {
        Self {
            calls,
            deadline: tokio::time::Instant::now() + Duration::from_secs(120),
        }
    }
    fn expired(&mut self, calls: usize, now: tokio::time::Instant) -> bool {
        if calls != self.calls {
            self.calls = calls;
            self.deadline = now + Duration::from_secs(120);
        }
        now >= self.deadline
    }
}
// test-category: pure-logic
#[test]
fn inactivity_deadline_preserves_active_work_and_detects_stops() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut wait = IdleWait::new(1);
    let origin = wait.deadline - Duration::from_secs(120);
    assert!(!wait.expired(2, origin + Duration::from_secs(119)));
    assert!(!wait.expired(2, origin + Duration::from_secs(121)));
    assert!(!wait.expired(2, origin + Duration::from_secs(238)));
    assert!(wait.expired(2, origin + Duration::from_secs(239)));
    Ok(())
}
