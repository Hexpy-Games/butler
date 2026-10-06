//! P. Performance (PERF-02): what the runtime spends per model round.
//!
//! The model is scripted, so the time between the end of one reply and the
//! next request is the product's own: tool run, journal, context projection,
//! serialization and admission. The context grows by one file per round.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fmt::Write;
use std::fs;
use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::provider::{Script, round_overheads};
use butler_e2e::e2e::scenario::{Setup, accepted_turn_id};

const ROUNDS: usize = 60;
const FILE_BYTES: usize = 22_000;

/// A file of words that tokenize like prose, distinct per `seed`.
fn prose(seed: usize) -> String {
    const WORDS: [&str; 16] = [
        "context", "window", "request", "provider", "message", "history", "round", "budget",
        "token", "runtime", "session", "digest", "surface", "result", "worker", "cache",
    ];
    let mut state = seed as u64 * 2_654_435_761 + 1;
    let mut text = String::with_capacity(FILE_BYTES + 16);
    while text.len() < FILE_BYTES {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let word = WORDS[(state >> 33) as usize % WORDS.len()];
        let _ = write!(text, "{word}{} ", (state >> 20) % 97);
        if (state >> 50).is_multiple_of(12) {
            text.push('\n');
        }
    }
    text
}

/// The `percent`th percentile of `sorted` (nearest rank).
fn percentile(sorted: &[Duration], percent: usize) -> Duration {
    let index = (sorted.len() * percent)
        .div_ceil(100)
        .clamp(1, sorted.len());
    sorted[index - 1]
}

/// PERF-02 — Exact tool history and final delivery at owner scale.
/// Selected only by the release-branch perf tier.
#[tokio::test]
async fn perf_02_round_overhead_at_large_context() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if std::env::var("BUTLER_E2E_PERF").as_deref() != Ok("1") {
        return Ok(());
    }
    let setup = Setup::new("PERF-02")?.synthetic(Script {
        rounds: ROUNDS,
        path_for: Box::new(|round| format!("perf-{round}.txt")),
        final_text: "All files read.".into(),
    });
    for round in 0..ROUNDS {
        fs::write(
            setup.sandbox.data.join(format!("perf-{round}.txt")),
            prose(round),
        )?;
    }
    let s = setup.start().await?;
    let accepted =
        s.gw.say(
            "general",
            "Read every perf file in your workspace, one per step.",
        )
        .await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let waited =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(600))
            .await;
    // Report what the rounds cost even when the turn does not finish.
    let timings = s.provider()?.timings();
    let overheads = round_overheads(&timings);
    let millis = |value: Duration| value.as_secs_f64() * 1e3;
    let line = overheads
        .iter()
        .map(|value| format!("{:.1}", millis(*value)))
        .collect::<Vec<_>>()
        .join(" ");
    eprintln!(
        "PERF-02 {} requests, per-round overhead ms: {line}",
        timings.len()
    );
    let turn = waited?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(
        timings.len(),
        ROUNDS + 1,
        "one request per round plus the answer"
    );
    let requests = s.provider()?.requests();
    assert_history(&requests);
    super::token_metrics::report(&s, &requests, "PERF-02 exact prefix tokens")?;
    let transcript_sizes: Vec<_> = requests
        .iter()
        .map(|request| serde_json::to_vec(&request["input"]).map(|bytes| bytes.len()))
        .collect::<Result<_, _>>()?;
    let transcript_bytes = *transcript_sizes.last().unwrap();
    eprintln!("PERF-02 transcript {transcript_bytes} bytes");
    assert!(
        transcript_bytes >= 1_400_000,
        "the transcript did not reach owner scale"
    );
    let messages = s.gw.messages("general").await?;
    let answers: Vec<_> = messages
        .iter()
        .filter(|message| message["role"] == "assistant")
        .collect();
    assert_eq!(answers.len(), 1);
    assert_eq!(answers[0]["text"], "All files read.");
    assert_eq!(overheads.len(), ROUNDS);
    let late: Vec<_> = overheads
        .iter()
        .zip(&transcript_sizes[1..])
        .filter(|(_, bytes)| **bytes >= 1_400_000)
        .map(|(overhead, _)| *overhead)
        .collect();
    assert!(!late.is_empty(), "no round reached owner scale");
    if std::env::var("BUTLER_E2E_PROFILE").as_deref() == Ok("1") {
        for (index, bytes) in transcript_sizes.iter().enumerate().skip(1) {
            if *bytes >= 1_400_000 {
                eprintln!(
                    "PERF-02 profile round {index}: {:?} -> {:?}",
                    timings[index - 1].replied,
                    timings[index].arrived
                );
            }
        }
    }
    let mut sorted = late;
    sorted.sort();
    let p95 = percentile(&sorted, 95);
    let bytes = timings.last().map_or(0, |timing| timing.request_bytes);
    eprintln!(
        "PERF-02 last request {bytes} bytes; {} owner-scale rounds p50 {:.1} ms p95 {:.1} ms",
        sorted.len(),
        millis(percentile(&sorted, 50)),
        millis(p95)
    );
    assert!(
        bytes >= 1_400_000,
        "the context did not reach 1.4 MB: {bytes}"
    );
    butler_e2e::assert_wall_clock_budget!(
        p95,
        Duration::from_millis(20),
        "PERF-02 p95 per-round overhead at owner scale",
    );
    s.finish().await
}

fn contains_text(value: &serde_json::Value, text: &str) -> bool {
    match value {
        serde_json::Value::String(value) => value == text,
        serde_json::Value::Array(values) => values.iter().any(|value| contains_text(value, text)),
        serde_json::Value::Object(values) => {
            values.values().any(|value| contains_text(value, text))
        }
        _ => false,
    }
}

fn assert_history(requests: &[serde_json::Value]) {
    let expected: Vec<_> = (0..ROUNDS).map(prose).collect();
    for (request_index, request) in requests.iter().enumerate() {
        let input = request["input"].as_array().unwrap();
        let outputs: Vec<_> = input
            .iter()
            .filter(|item| item["type"] == "function_call_output")
            .collect();
        assert_eq!(
            outputs.len(),
            request_index,
            "latest history on every request"
        );
        for (round, item) in outputs.iter().enumerate() {
            let decoded: serde_json::Value =
                serde_json::from_str(item["output"].as_str().unwrap()).unwrap();
            assert_eq!(decoded["ok"], true);
            assert!(
                contains_text(&decoded, &expected[round]),
                "exact file content in order: {round}"
            );
            assert_eq!(item["call_id"], format!("call_synthetic{round}"));
        }
    }
}
