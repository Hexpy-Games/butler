//! A failing hook blocks the events that can block, unless it sets `failClosed: false`.
use super::*;

const CONTENT: &str = "Exact tool content";
const ASK: &str = "Read hook-input.txt, then finish.";

/// One read of a data file, then an answer.
fn reading(name: &str) -> Result<Setup, HarnessError> {
    let setup = setup(name)?.synthetic(Script {
        rounds: 1,
        path_for: Box::new(|_| "hook-input.txt".into()),
        final_text: "Done.".into(),
    });
    fs::write(setup.sandbox.data.join("hook-input.txt"), CONTENT)?;
    Ok(setup)
}

/// A hook named "Command guard" that prints `text` and exits with `code`.
fn printing(setup: &Setup, event: &str, text: &str, code: &str) -> Value {
    let mut hook = super::context::printing(setup, "guard", event, text);
    hook["name"] = json!("Command guard");
    hook["env"]["HOOK_EXIT"] = json!(code);
    if event.ends_with("ToolUse") {
        hook["match"] = json!({"tools":["read_file"]});
    }
    hook
}

/// Everything the model heard after its first request.
fn heard(s: &Scenario) -> Result<String, HarnessError> {
    Ok(s.provider()?
        .requests()
        .iter()
        .skip(1)
        .map(Value::to_string)
        .collect())
}

async fn blocks(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    Ok(s.gw
        .events_since(0)
        .await?
        .into_iter()
        .filter(|event| event["type"] == "hook.blocked")
        .map(|event| event["payload"].clone())
        .collect())
}

async fn outcome(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    let runs = api(s, Method::GET, "/hooks/runs", None).await?;
    let runs = runs.data().as_array().unwrap().clone();
    Ok(runs.into_iter().find(|run| run["hook_id"] == id).unwrap()["outcome"].clone())
}

/// The tool did not run, the model heard why, and the App was told which hook.
async fn assert_tool_blocked(s: &Scenario, reason: &str) -> Result<(), HarnessError> {
    let (_, turn) = s.turn("general", ASK).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let heard = heard(s)?;
    assert!(!heard.contains(CONTENT), "the blocked tool ran: {heard}");
    assert!(heard.contains("hook_denied"), "{heard}");
    assert!(heard.contains(reason), "{heard}");
    let deadline = Instant::now() + Duration::from_secs(10);
    let blocks = loop {
        let blocks = blocks(s).await?;
        if !blocks.is_empty() {
            break blocks;
        }
        assert!(Instant::now() < deadline, "no hook.blocked event");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(blocks.len(), 1, "{blocks:?}");
    assert_eq!(blocks[0]["hook"], "Command guard", "{blocks:?}");
    assert_eq!(blocks[0]["event"], "PreToolUse", "{blocks:?}");
    assert_eq!(blocks[0]["tool"], "read_file", "{blocks:?}");
    assert_eq!(blocks[0]["reason"], reason, "{blocks:?}");
    Ok(())
}

#[tokio::test]
async fn hooks_failing_guard_blocks_tool_and_names_hook() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = reading("HOOK-FAIL-EXIT")?;
    configure(&setup, &[printing(&setup, "PreToolUse", "", "1")])?;
    let s = setup.start().await?;
    assert_tool_blocked(&s, "Command guard: hook failed (exited with code 1)").await?;
    assert_eq!(outcome(&s, "guard").await?, "error");
    s.finish().await
}

#[tokio::test]
async fn hooks_timed_out_guard_blocks_tool() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = reading("HOOK-FAIL-TIMEOUT")?;
    let mut hook = printing(&setup, "PreToolUse", "", "0");
    hook["args"] = json!(fixture(&setup, "hold"));
    hook["env"] = json!({"HOOK_HELD":setup.sandbox.home.join("held"),
        "HOOK_RELEASE":setup.sandbox.home.join("never")});
    hook["timeout_ms"] = json!(300);
    configure(&setup, &[hook])?;
    let s = setup.start().await?;
    assert_tool_blocked(&s, "Command guard: hook failed (timed out after 300 ms)").await?;
    assert_eq!(outcome(&s, "guard").await?, "timeout");
    s.finish().await
}

#[tokio::test]
async fn hooks_unreadable_json_guard_blocks_tool() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = reading("HOOK-FAIL-JSON")?;
    configure(
        &setup,
        &[printing(&setup, "PreToolUse", "{\"decision\":", "0")],
    )?;
    let s = setup.start().await?;
    assert_tool_blocked(&s, "Command guard: hook failed (printed invalid JSON)").await?;
    assert_eq!(outcome(&s, "guard").await?, "error");
    s.finish().await
}

/// A rejected send names the hook in its own response, so no event repeats it.
#[tokio::test]
async fn hooks_failing_prompt_guard_rejects_send_naming_hook() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = reading("HOOK-FAIL-PROMPT")?;
    configure(&setup, &[printing(&setup, "UserPromptSubmit", "", "1")])?;
    let s = setup.start().await?;
    let blocked =
        s.gw.post("/messages", json!({"chat_id":"general","text":ASK}))
            .await?;
    assert_eq!(blocked.status, 422, "{blocked:?}");
    assert_eq!(blocked.error_code(), Some("hook_blocked"));
    assert_eq!(
        blocked.body["error"]["message"], "Command guard: hook failed (exited with code 1)",
        "{blocked:?}"
    );
    assert_eq!(s.gw.turns("general").await?, [] as [Value; 0]);
    assert_eq!(blocks(&s).await?, [] as [Value; 0]);
    s.finish().await
}

#[tokio::test]
async fn hooks_fail_closed_false_lets_events_continue() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = reading("HOOK-FAIL-OPEN")?;
    let mut prompt = printing(&setup, "UserPromptSubmit", "", "1");
    prompt["id"] = json!("prompt");
    prompt["failClosed"] = json!(false);
    let mut tool = printing(&setup, "PreToolUse", "{\"decision\":", "0");
    tool["failClosed"] = json!(false);
    configure(&setup, &[prompt, tool])?;
    let s = setup.start().await?;
    let (_, turn) = s.turn("general", ASK).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert!(heard(&s)?.contains(CONTENT), "the tool did not run");
    assert_eq!(outcome(&s, "prompt").await?, "error");
    assert_eq!(outcome(&s, "guard").await?, "error");
    assert_eq!(blocks(&s).await?, [] as [Value; 0]);
    s.finish().await
}

#[tokio::test]
async fn hooks_failing_observers_continue() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = reading("HOOK-FAIL-OBSERVE")?;
    let mut start = printing(&setup, "SessionStart", "", "1");
    start["id"] = json!("start");
    let mut post = printing(&setup, "PostToolUse", "", "1");
    post["id"] = json!("post");
    configure(&setup, &[start, post])?;
    let s = setup.start().await?;
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Observed"}))
            .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    let (_, turn) = s.turn(&chat, ASK).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert!(heard(&s)?.contains(CONTENT), "the tool did not run");
    assert_eq!(outcome(&s, "start").await?, "error");
    assert_eq!(outcome(&s, "post").await?, "error");
    assert_eq!(blocks(&s).await?, [] as [Value; 0]);
    s.finish().await
}
