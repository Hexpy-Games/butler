//! Folding keeps a turn's hook output labelled for the model that summarizes it.
use super::*;

#[tokio::test]
async fn folded_turn_carries_its_labelled_hook_context() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, stub, server) = start_with("1h", "on", true, &[]).await?;
    stub.text_only
        .store(true, std::sync::atomic::Ordering::Relaxed);
    register_small_model(&s).await?;
    let text = "HOOK-FOLD-TEXT";
    let command = if butler_platform::command_sandbox::POSIX_SHELL {
        format!("printf {text}")
    } else {
        format!("echo {text}")
    };
    let hook = json!({"id":"fold","event":"UserPromptSubmit","type":"command","command":command,
        "timeout_ms":10000});
    let hooks = s.sandbox.data.join("hooks.json");
    std::fs::write(&hooks, json!({"version":1,"hooks":[hook]}).to_string())?;
    let controls =
        s.gw.patch(
            "/sessions/general/controls",
            json!({"model":"anthropic/claude-haiku-4-5"}),
        )
        .await?;
    assert_eq!(controls.status, 200, "{}", controls.text);
    s.turn("general", FACT).await?;
    std::fs::write(&hooks, json!({"version":1,"hooks":[]}).to_string())?;
    s.agent.terminate().await?;
    let id = seed(
        &s.sandbox.data.join("runtime/conversation-store.sqlite"),
        32,
        2600,
    )?;
    let path = summary_path(&s, &id);
    s.gw = s.agent.start_again().await?;
    s.turn("general", "Begin continuity catch-up.").await?;
    settle(&path, &stub).await?;
    let requests = stub.continuity.requests.lock().unwrap().clone();
    let folded = requests
        .iter()
        .map(text_of)
        .find(|prompt| prompt.contains(FACT))
        .expect("the hook's turn was folded");
    let user = folded.find(&format!("user: {FACT}")).unwrap();
    let section = folded.find("## Hook context").unwrap();
    let hook_text = folded.find(text).unwrap();
    let answer = folded[hook_text..].find("butler").unwrap() + hook_text;
    assert!(
        user < section && section < hook_text && hook_text < answer,
        "{folded}"
    );
    assert!(folded.contains("not written by the user"), "{folded}");
    s.finish().await?;
    server.abort();
    Ok(())
}

fn text_of(request: &Value) -> String {
    super::text(request)
}
