//! Explicit memory written by a chat survives restart.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::{HarnessError, fixtures, nonce};
use serde_json::Value;

fn recalled(result: &Value, needle: &str) -> bool {
    result.to_string().contains(needle)
}
fn stored_rules(s: &Scenario, _cue: &str) -> Result<Value, HarnessError> {
    let root = s.sandbox.data.join("cognition/memory/rules");
    let mut texts = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "md") {
            texts.push(std::fs::read_to_string(path)?);
        }
    }
    Ok(serde_json::json!(texts))
}

#[tokio::test]
async fn mem_01_chat_memory_source_survives_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let code = nonce();
    let setup = Setup::new("MEM-01")?
        .cassette("MEM-01")
        .placeholder("NONCE", &code);
    fixtures::embedding_assets(&setup.sandbox.data)?;
    let mut s = setup.start().await?;
    let (turn_id, turn) = s
        .turn(
            "general",
            &format!(
                "Please save this as a durable explicit memory so you remember it in future conversations: my bike lock code is {code}. Use your explicit memory tool, then confirm in one short sentence."
            ),
        )
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let write = rows
        .iter()
        .find(|row| {
            row.to_string().contains("update_explicit_memory") && row["state"] == "delivered"
        })
        .unwrap_or_else(|| panic!("no delivered explicit memory write: {rows:#?}"));
    let output = s.gw.operation_output(&turn_id, write).await?;
    let root = s.sandbox.root.display().to_string();
    assert!(
        !output.contains(&root),
        "memory tool result shows a private path: {output}"
    );
    assert!(
        !output.contains("job_id"),
        "memory tool result shows a job id: {output}"
    );

    let result = stored_rules(&s, "bike lock code")?;
    assert!(
        recalled(&result, &code),
        "remembered fact not recalled: {result}"
    );
    s.restart().await?;
    let result = stored_rules(&s, "bike lock code")?;
    assert!(
        recalled(&result, &code),
        "recall lost across restart: {result}"
    );
    s.finish().await
}
