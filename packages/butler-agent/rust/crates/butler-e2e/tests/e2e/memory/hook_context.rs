//! With extraction running, hook output never becomes a remembered user fact.
use super::*;
use std::time::{Duration, Instant};

#[tokio::test]
async fn mem_hook_context_is_not_a_memory_source() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let code = nonce();
    let canary = "HOOK-MEMORY-CANARY: the bike lock code of the user is 0000";
    let mut cassette = butler_e2e::e2e::cassette::Cassette::load("MEM-01")?;
    memory_stubs::extraction(&mut cassette, "")?;
    let setup = Setup::new("MEM-HOOK-CONTEXT")?
        .stub_cassette(cassette)
        .placeholder("NONCE", &code);
    fixtures::embedding_assets(&setup.sandbox.data)?;
    let command = if butler_platform::command_sandbox::POSIX_SHELL {
        format!("printf '%s' '{canary}'")
    } else {
        format!("echo {canary}")
    };
    std::fs::write(
        setup.sandbox.data.join("hooks.json"),
        serde_json::json!({"version":1,"hooks":[{"id":"canary","event":"UserPromptSubmit",
            "type":"command","command":command,"timeout_ms":10000}]})
        .to_string(),
    )?;
    let s = setup.start().await?;
    let ask = format!(
        "Please save this as a durable explicit memory so you remember it in future conversations: my bike lock code is {code}. Use your explicit memory tool, then confirm in one short sentence."
    );
    let (_, turn) = s.turn("general", &ask).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains(canary)),
        "the hook's text never reached the turn"
    );
    // Extraction read this turn, so its silence on the canary means something.
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let memory = s.provider()?.memory_requests();
        if memory.iter().any(|r| r.to_string().contains(&code)) {
            assert!(
                memory.iter().all(|r| !r.to_string().contains(canary)),
                "hook output reached memory extraction"
            );
            break;
        }
        assert!(Instant::now() < deadline, "extraction never read the turn");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        !stored_rules(&s, "bike lock code")?
            .to_string()
            .contains("HOOK-MEMORY-CANARY")
    );
    s.finish().await
}
