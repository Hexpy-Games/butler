//! E. Memory write & recall (SCENARIOS.md MEM-01..04).
//!
//! Recall needs the local BGE-M3 embedding model (570 MB, pinned Hugging Face
//! revision). The harness installs it from `BUTLER_E2E_EMBEDDING_ASSETS`;
//! without it these scenarios report `SKIPPED (embedding assets)`. The e2e
//! workflow fetches and caches the pinned files.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::{HarnessError, fixtures, live, nonce};
use serde_json::Value;

async fn cli_json(s: &Scenario, args: &[&str]) -> Result<Value, HarnessError> {
    s.agent.cli_async(args).await?.json()
}

async fn session_hint(s: &Scenario, chat: &str) -> Result<String, HarnessError> {
    let sessions = s.gw.get("/sessions").await?;
    Ok(sessions.data()["sessions"]
        .as_array()
        .and_then(|list| list.iter().find(|session| session["id"] == chat))
        .and_then(|session| session["session_hint"].as_str())
        .unwrap_or(chat)
        .to_owned())
}

fn recalled(result: &Value, needle: &str) -> bool {
    result["data"]["results"].to_string().contains(needle)
}

/// MEM-02 — Conversation ingest makes a past chat recallable, across restart.
#[tokio::test]
#[ignore = "product gap: MEM-02-INBOUND — App chat user messages are not written to the session transcript, so `butler cognition memory ingest --session` summarizes only Butler's replies (the ingest prompt holds just `butler: <reply>`) and a fact the user stated is never recallable. The MEM-02 cassette also lacks the ingest summary exchange: re-record it once this is fixed"]
async fn mem_02_conversation_ingest_is_recallable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let code = nonce();
    let setup = Setup::new("MEM-02")?
        .cassette("MEM-02")
        .placeholder("NONCE", &code);
    if !fixtures::embedding_assets(&setup.sandbox.data)? {
        live::report(
            "MEM-02",
            "SKIPPED (embedding assets: set BUTLER_E2E_EMBEDDING_ASSETS)",
        );
        return Ok(());
    }
    let mut s = setup.start().await?;
    let (_, turn) = s
        .turn(
            "general",
            &format!(
                "For my garden notes: the greenhouse door code is {code}. Just acknowledge briefly."
            ),
        )
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let hint = session_hint(&s, "general").await?;
    let ingest = cli_json(
        &s,
        &[
            "cognition",
            "memory",
            "ingest",
            "--session",
            &hint,
            "--json",
        ],
    )
    .await?;
    assert_eq!(ingest["ok"], true, "{ingest}");
    let result = cli_json(
        &s,
        &[
            "cognition",
            "memory",
            "recall",
            "greenhouse door code",
            "--json",
        ],
    )
    .await?;
    assert!(
        recalled(&result, &code),
        "ingested fact not recalled: {result}"
    );
    s.restart().await?;
    let result = cli_json(
        &s,
        &[
            "cognition",
            "memory",
            "recall",
            "greenhouse door code",
            "--json",
        ],
    )
    .await?;
    assert!(
        recalled(&result, &code),
        "recall lost across restart: {result}"
    );
    s.finish().await
}

async fn recall(s: &Scenario, cue: &str) -> Result<Value, HarnessError> {
    cli_json(s, &["cognition", "memory", "recall", cue, "--json"]).await
}

/// MEM-01 — A fact the user asks Butler to remember is written by the
/// explicit memory tool, recallable, and survives a restart; the tool result
/// shows no private paths or internal job ids. (The spec's forget half —
/// `cognition box forget`, `box rebuild-index` — follows once a memory can be
/// written from a chat at all.)
#[tokio::test]
#[ignore = "product gap: MEM-01-WRITE — in an App chat the explicit memory tool is outside the session's tool surface: tool_search lists update_explicit_memory with enabled:false (`outside the current session's scoped progressive surface`; only a session binding that already carries the memory-write profile gets it), so asking Butler to remember a fact writes nothing and recall returns no result. The MEM-01 cassette is that real exchange (the model answers that the memory tool is unavailable); re-record it once fixed"]
async fn mem_01_remember_and_recall() -> Result<(), HarnessError> {
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

    let result = recall(&s, "bike lock code").await?;
    assert!(
        recalled(&result, &code),
        "remembered fact not recalled: {result}"
    );
    s.restart().await?;
    let result = recall(&s, "bike lock code").await?;
    assert!(
        recalled(&result, &code),
        "recall lost across restart: {result}"
    );
    s.finish().await
}
