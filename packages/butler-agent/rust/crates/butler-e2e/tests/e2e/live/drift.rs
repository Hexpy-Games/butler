//! A dedicated plain-answer baseline; old memory recordings remain replayable.
use std::path::PathBuf;

use butler_e2e::e2e::config::{LiveProvider, ModelChoice, flag, nonempty};
use butler_e2e::e2e::{HarnessError, cassette, harness_error, sanitize};

const BASELINE: &str = "LIVE-09";
pub(super) const PROMPT: &str = "Reply with exactly: memory check";

pub(super) async fn check(provider: &LiveProvider) -> Result<(), HarnessError> {
    let recording = flag("BUTLER_E2E_RECORD");
    let committed = cassette::Cassette::load(if recording { "MEM-03" } else { BASELINE })?;
    let index = committed
        .exchanges
        .iter()
        .position(|exchange| exchange.request.key.user_request == PROMPT)
        .ok_or_else(|| harness_error("canonical drift exchange missing"))?;
    if committed.meta.provider != provider.provider {
        return Err(harness_error(
            "drift baseline provider does not match live provider",
        ));
    }
    // Live recording must never inherit another model from a historical cassette.
    let choice = ModelChoice::parse("openai/gpt-6-luna@max")
        .ok_or_else(|| harness_error("invalid drift recording model"))?;
    let temporary = std::env::temp_dir().join(format!(
        "butler-e2e-drift-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let s = super::Setup::new(BASELINE)?
        .cassette(BASELINE)
        .model(choice)
        .record_into(temporary.clone())
        .start()
        .await?;
    let (_, turn) = super::live_turn(&s, "general", PROMPT).await?;
    assert_eq!(super::turn_state(&turn), "delivered");
    s.finish().await?;
    let mut fresh = cassette::load_from(&temporary, BASELINE)?;
    std::fs::remove_dir_all(&temporary)?;
    assert_eq!(
        fresh.exchanges.len(),
        1,
        "plain drift turn must record one exchange"
    );
    if recording {
        let output = PathBuf::from(
            nonempty("BUTLER_E2E_RECORD_OUTPUT")
                .ok_or_else(|| harness_error("recording requires an explicit cassette output"))?,
        );
        fresh.exchanges[0].response.headers.clear();
        fresh
            .meta
            .sanitization
            .push("all response headers removed".into());
        for exchange in &fresh.exchanges {
            assert!(
                sanitize::lint(&serde_json::to_string(exchange)?).is_empty(),
                "recorded cassette failed secret scrub"
            );
        }
        cassette::write(&output, fresh.meta, &fresh.exchanges)?;
        super::live::report(BASELINE, "RECORDED (openai/gpt-6-luna, sanitized)");
    } else {
        assert_eq!(
            normalize(&fresh.meta.fingerprint[0]),
            normalize(&committed.meta.fingerprint[index]),
            "provider stream shape drifted; re-record cassettes (BUTLER_E2E_RECORD=1)"
        );
    }
    Ok(())
}

fn normalize(print: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for entry in print {
        if !out.contains(entry) {
            out.push(entry.clone());
        }
    }
    out
}
