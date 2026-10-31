//! Output too large for one turn is previewed or refused in the open, never cut silently.
use super::context::{printing, prompts, section, split};
use super::*;

const HEAD: &str = "HOOK-HEAD-MARKER";
const TAIL: &str = "HOOK-TAIL-MARKER";

fn from_file(setup: &Setup, id: &str, body: &str) -> Result<Value, HarnessError> {
    let path = setup.sandbox.home.join(format!("{id}.txt"));
    fs::write(&path, body)?;
    let mut hook = printing(setup, id, "UserPromptSubmit", "");
    hook["env"] = json!({"HOOK_FILE":path});
    hook["timeout_ms"] = json!(60000);
    Ok(hook)
}

/// Follows the preview's own instructions to read the rest of the output.
fn read_rest(body: &Value) -> Option<butler_e2e::e2e::cassette::ResponseRecord> {
    let inputs = body["input"].as_array()?;
    let prompt = inputs.first()?["content"][0]["text"].as_str()?;
    let id = prompt
        .split("Artifact ID: ")
        .nth(1)?
        .split_whitespace()
        .next()?;
    let described = inputs
        .iter()
        .any(|item| item["type"] == "function_call_output" && item["call_id"] == "hook_describe");
    if !described {
        return Some(stub::response(
            &json!({"type":"function_call","id":"hook_describe","call_id":"hook_describe",
                "name":"tool_describe","status":"completed",
                "arguments":json!({"ids":["native:read_tool_output_artifact"]}).to_string()}),
        ));
    }
    stub::tool(
        body,
        "tool_call",
        &json!({"id":"native:read_tool_output_artifact",
            "arguments":{"artifact_id":id,"search":"TAIL-MARKER"}}),
    )
}

#[tokio::test]
async fn hooks_context_large_output_is_previewed_and_stays_readable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("HOOK-CONTEXT-LARGE")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let body = format!(
        "{HEAD}\n{}{TAIL}\n",
        "a varied line of context 한글 number\n".repeat(6000)
    );
    configure(&setup, &[from_file(&setup, "large", &body)?])?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(read_rest);
    let (_, turn) = s.turn("general", "Use the hook output.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");

    let all = prompts(&s)?;
    let (_, current) = split(&all[0]);
    assert!(current.contains(HEAD) && current.contains("hook=\"large\""));
    assert!(current.contains("[This hook printed"), "{current}");
    assert!(
        !current.contains(TAIL),
        "the preview holds the whole output"
    );
    assert!(current.contains("Butler compacted"), "{current}");
    let id = current
        .split("Artifact ID: ")
        .nth(1)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned();

    // The model is told, and the same call a tool result would use reads the rest.
    let requests = s.provider()?.requests();
    let output = requests
        .iter()
        .filter_map(|request| request["input"].as_array())
        .flatten()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == "call_hooks")
        .unwrap();
    let read: Value = serde_json::from_str(output["output"].as_str().unwrap())?;
    let stdout = &read["output"]["stdout"];
    assert_eq!(stdout["search"]["found"], true, "{read}");
    let path = read["output"]["artifact"]["path"].as_str().unwrap();
    let stored: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    assert_eq!(
        stored["result"]["stdout"],
        body.trim(),
        "the original was kept"
    );

    // The run log says what happened and to how much output.
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    let run = runs.data().as_array().unwrap().first().unwrap().clone();
    assert_eq!(run["outcome"], "continue");
    assert_eq!(run["context_bytes"], body.trim().len());
    assert!(run["reason"].as_str().unwrap().contains(&id), "{run}");
    assert!(run["reason"].as_str().unwrap().contains("preview"), "{run}");

    // Same preview on every later round: a stable turn, not a new artifact each.
    assert_eq!(section(all.last().unwrap()), section(&all[0]));
    s.finish().await
}

#[tokio::test]
async fn hooks_context_past_the_tool_budget_bytes_stays_exact_within_tokens()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("HOOK-CONTEXT-EXACT")?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    // Long runs of one letter are few tokens per byte: over 8,000 bytes, under the budget.
    let body = format!("{HEAD} {} {TAIL}", "x".repeat(20_000));
    configure(&setup, &[from_file(&setup, "exact", &body)?])?;
    let s = setup.start().await?;
    assert_eq!(s.turn("general", "Exact.").await?.1["state"], "delivered");
    let prompt = prompts(&s)?.pop().unwrap();
    assert!(prompt.contains(&body), "the text within budget changed");
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    let run = runs.data().as_array().unwrap().first().unwrap().clone();
    assert_eq!(run["context_bytes"], body.len());
    assert!(run["reason"].is_null(), "{run}");
    s.finish().await
}

#[tokio::test]
async fn hooks_context_over_the_read_bound_tells_model_and_run_log() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("HOOK-CONTEXT-BOUND")?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let limit = butler_platform::hook_process::CONTEXT_OUTPUT_LIMIT;
    let body = format!("{HEAD}{}", "x".repeat(limit));
    configure(&setup, &[from_file(&setup, "flood", &body)?])?;
    let s = setup.start().await?;
    assert_eq!(s.turn("general", "Goes on.").await?.1["state"], "delivered");
    let prompt = prompts(&s)?.pop().unwrap();
    assert!(
        !prompt.contains(HEAD),
        "over-bound output reached the model"
    );
    assert!(
        prompt.contains("hook=\"flood\"")
            && prompt.contains("added none of this hook's output: Hook output exceeds 10240 KiB"),
        "{prompt}"
    );
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    let run = runs.data().as_array().unwrap().first().unwrap().clone();
    assert_eq!(run["outcome"], "error", "{run}");
    assert!(
        run["stderr"]
            .as_str()
            .unwrap()
            .contains("exceeds 10240 KiB"),
        "{run}"
    );
    assert!(run["context_bytes"].is_null(), "{run}");
    s.finish().await
}

/// A read-only session gets the preview and is told the rest is out of reach;
/// the tool stays closed there because it is not scoped to the session.
#[tokio::test]
async fn hooks_context_oversized_output_is_preview_only_in_read_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("HOOK-CONTEXT-RO")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let body = format!(
        "{HEAD}\n{}{TAIL}\n",
        "a varied line of context 한글 number\n".repeat(6000)
    );
    configure(&setup, &[from_file(&setup, "large", &body)?])?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(read_rest);
    s.patch_settings(json!({"access_mode":"read_only"}), "access")
        .await?;
    let (_, turn) = s.turn("general", "Use the hook output.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let all = prompts(&s)?;
    assert!(all[0].contains("- access: read_only"), "{}", all[0]);
    let (_, current) = split(&all[0]);
    assert!(
        current.contains(HEAD) && !current.contains(TAIL),
        "not a preview"
    );
    assert!(
        current
            .contains("In a read-only session the full text of a previewed item is not available."),
        "{current}"
    );
    let requests = s.provider()?.requests();
    let output = requests
        .iter()
        .filter_map(|request| request["input"].as_array())
        .flatten()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == "call_hooks")
        .unwrap();
    let read: Value = serde_json::from_str(output["output"].as_str().unwrap())?;
    assert_eq!(read["ok"], false, "{read}");
    assert_eq!(read["error"]["code"], "disabled_tool", "{read}");
    s.finish().await
}

/// Background handlers add nothing, so they keep the 64 KiB bound; the other
/// event of the pair cannot be a background handler at all.
#[tokio::test]
async fn hooks_context_async_handlers_keep_the_decision_bound() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("HOOK-CONTEXT-ASYNC")?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let limit = butler_platform::hook_process::OUTPUT_LIMIT;
    let mut flood = from_file(&setup, "flood", &"x".repeat(limit + 1))?;
    flood["event"] = json!("SessionStart");
    flood["async"] = json!(true);
    let mut pre_event = flood.clone();
    pre_event["event"] = json!("UserPromptSubmit");
    configure(&setup, &[flood])?;
    let s = setup.start().await?;
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Flood"}))
            .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    let deadline = Instant::now() + Duration::from_secs(30);
    let run = loop {
        let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
        if let Some(run) = runs.data().as_array().unwrap().first() {
            break run.clone();
        }
        assert!(Instant::now() < deadline, "the background hook never ended");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(run["outcome"], "error", "{run}");
    assert!(
        run["stderr"].as_str().unwrap().contains("exceeds 64 KiB"),
        "{run}"
    );
    assert_eq!(s.turn(&chat, "Goes on.").await?.1["state"], "delivered");
    assert!(!prompts(&s)?.pop().unwrap().contains("## Hook context"));

    let current = api(&s, Method::GET, "/hooks", None).await?;
    let refused = api(
        &s,
        Method::PUT,
        "/hooks",
        Some(json!({"revision":current.data()["revision"],"config":{"version":1,"hooks":[pre_event]}})),
    )
    .await?;
    assert_ne!(refused.status, 200, "{refused:?}");
    s.finish().await
}
