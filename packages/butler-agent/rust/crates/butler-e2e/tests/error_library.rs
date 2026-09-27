//! Error library (PROVIDER_CONFIG.md §4.1): real provider error replies that
//! failure injections may use. Recording only happens with
//! `BUTLER_E2E_RECORD=1`; the stub tier checks the committed entries load.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::cassette::Cassette;
use butler_e2e::e2e::config::flag;
use butler_e2e::e2e::scenario::Setup;

/// `_errors/codex-401`: the subscription endpoint's reply to a request that
/// carries an invalid access token (a syntactically plain, revoked-looking
/// token written into the scenario's own Codex auth file).
#[tokio::test]
async fn error_library_codex_401() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !flag("BUTLER_E2E_RECORD") {
        let entry = Cassette::load("_errors/codex-401")?;
        assert_eq!(entry.exchanges[0].response.status, 401);
        return Ok(());
    }
    let setup = Setup::new("ERRORS-401")?.cassette("_errors/codex-401");
    let bogus = setup.sandbox.root.join("invalid-codex-auth.json");
    std::fs::write(
        &bogus,
        r#"{"tokens":{"access_token":"e2e-invalid-access-token"}}"#,
    )?;
    let s = setup
        .env("CODEX_AUTH_JSON", bogus.display().to_string())
        .start()
        .await?;
    let (_, turn) = s
        .turn("general", "Reply with exactly the word: unauthorized")
        .await?;
    assert_eq!(turn["state"], "failed", "{turn}");
    s.finish().await
}
