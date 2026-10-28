//! Drive provider-decoded calls through the real loop's tool-feedback path.
use butler_turn::btcc::{
    AgentLoop, ModelRoundMessage, ModelRoundResult, NOOP_MODEL_ROUND_OBSERVER,
    agent_loop::{test_data, test_support::Fixture},
};
use tokio_util::sync::CancellationToken;

pub(super) async fn feedback(
    result: ModelRoundResult,
) -> Result<Vec<ModelRoundMessage>, super::Error> {
    let mut final_round = result.clone();
    final_round.text = Some("Recovered".into());
    final_round.tool_calls.clear();
    final_round.output_truncated = false;
    final_round.stop = butler_turn::btcc::ModelStop::Complete;
    final_round.assistant_message = None;
    let fixture = Fixture::new([result, final_round]);
    let outcome = fixture
        .agent()
        .run(
            &test_data::turn(None, "safe_fallback"),
            &test_data::claim(),
            1,
            fixture.as_ref(),
            &NOOP_MODEL_ROUND_OBSERVER,
            CancellationToken::new(),
        )
        .await?;
    assert_eq!(outcome.content, "Recovered");
    let history = fixture
        .request_history
        .lock()
        .map_err(|_| "history poisoned")?;
    let messages = history.last().ok_or("correction round missing")?.clone();
    assert!(
        messages
            .iter()
            .any(|message| message.content.contains("output_truncated"))
    );
    assert!(
        !fixture
            .events
            .lock()
            .map_err(|_| "events poisoned")?
            .iter()
            .any(|event| event.starts_with("execute:"))
    );
    Ok(messages)
}
