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

use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::{HarnessError, fixtures, live, nonce};
use serde_json::Value;

fn cli_json(s: &Scenario, args: &[&str]) -> Result<Value, HarnessError> {
    s.agent.cli(args)?.json()
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
    )?;
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
    )?;
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
    )?;
    assert!(
        recalled(&result, &code),
        "recall lost across restart: {result}"
    );
    s.finish().await
}
