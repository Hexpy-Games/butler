//! A plugin secret never reaches the model through hook output, however it was encoded.
use super::*;

/// The secret as the hook's JSON encoder writes it, and as jq and Python would.
const SECRET: &str = "pa\"ss-한글";
const JQ_FORM: &str = "pa\\\"ss-한글";
const PYTHON_FORM: &str = "pa\\\"ss-\\ud55c\\uae00";

fn final_answer(_: &Value) -> Option<butler_e2e::e2e::cassette::ResponseRecord> {
    Some(
        serde_json::from_value(json!({"status":200,"headers":[],"chunks":[{"delay_ms":0,
            "text":format!("event: response.completed\ndata: {}\n\n", json!({
                "type":"response.completed","sequence_number":0,"response":{"id":"r","object":"response",
                "status":"completed","model":"gpt-6-luna","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},
                "output":[{"type":"message","id":"m","role":"assistant","status":"completed","phase":"final_answer",
                    "content":[{"type":"output_text","text":"Done.","annotations":[]}]}]}}))}]}))
        .unwrap(),
    )
}

/// One hook per encoding; each prints a whole JSON decision from its own file.
fn hook(root: &Path, id: &str, secret_form: &str) -> Result<Value, HarnessError> {
    let body = format!(
        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"HOOK-PLUGIN-TEXT token={secret_form}\"}}}}"
    );
    fs::write(root.join(format!("{id}.json")), body)?;
    let args = if butler_platform::command_sandbox::POSIX_SHELL {
        fs::write(
            root.join(format!("{id}.sh")),
            format!("#!/bin/sh\ncat \"$BUTLER_PLUGIN_ROOT/{id}.json\"\n"),
        )?;
        json!(["sh", format!("${{BUTLER_PLUGIN_ROOT}}/{id}.sh")])
    } else {
        fs::write(
            root.join(format!("{id}.cmd")),
            format!("@echo off\r\ntype \"%BUTLER_PLUGIN_ROOT%\\{id}.json\"\r\n"),
        )?;
        json!([
            "cmd.exe",
            "/d",
            "/s",
            "/c",
            format!("${{BUTLER_PLUGIN_ROOT}}/{id}.cmd")
        ])
    };
    Ok(json!({"id":id,"type":"command","event":"UserPromptSubmit","args":args}))
}

#[tokio::test]
async fn hook_context_redacts_secrets_after_decoding_json() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG-HOOK-CONTEXT")?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    butler_platform::secrets::prepare_system_keychain_for_test(&setup.sandbox.home)?;
    let root = package(&setup.sandbox.home, "helper")?;
    let hooks = [
        hook(&root, "jq", JQ_FORM)?,
        hook(&root, "python", PYTHON_FORM)?,
    ];
    fs::write(
        root.join("hooks.json"),
        json!({"version":1,"hooks":hooks}).to_string(),
    )?;
    fs::write(
        root.join("plugin.json"),
        json!({"name":"helper","version":"1.2.3","author":{"name":"Unverified author"},
            "extensions":{"io.github.hexpy-games.butler":{"api":1,"hooks":"hooks.json",
            "capabilities":{"secrets":[{"key":"PRIVATE_TOKEN","label":"Token"}]}}}})
        .to_string(),
    )?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(final_answer);
    let i = inspect(&s, &root).await?;
    let installed = api(
        &s,
        Method::POST,
        "/plugins/install",
        Some(json!({
        "staging_id":i["staging_id"],"digest":i["digest"],"revision":revision(&s).await?,
        "secrets":{"PRIVATE_TOKEN":SECRET}})),
    )
    .await?;
    assert_eq!(installed.status, 200, "{installed:?}");
    let (_, turn) = s.turn("general", "Use the plugin hook output.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");

    let wire = serde_json::to_string(&s.provider()?.requests())?;
    let prompt = s
        .provider()?
        .requests()
        .iter()
        .filter_map(|r| {
            r["input"][0]["content"][0]["text"]
                .as_str()
                .map(str::to_owned)
        })
        .find(|text| text.contains("## Current turn context"))
        .unwrap();
    assert_eq!(
        prompt.matches("HOOK-PLUGIN-TEXT token=[redacted]").count(),
        2,
        "{prompt}"
    );
    assert!(prompt.contains("scope=plugin"), "{prompt}");
    assert!(!prompt.contains(SECRET), "the secret reached the model");
    assert!(
        !wire.contains("pa\\\"ss") && !wire.contains("ud55c"),
        "encoded secret"
    );
    // The durable copies are the redacted text too.
    let db =
        butler_platform::sqlite::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
    let stored: String = db.query_row(
        "SELECT p.content_json FROM conversation_parts p JOIN conversation_messages m \
         ON m.id=p.message_id WHERE m.source_ref LIKE '%:hook-context'",
        [],
        |row| row.get(0),
    )?;
    assert!(
        stored.contains("[redacted]") && !stored.contains("ss-한글"),
        "{stored}"
    );
    s.finish().await
}
