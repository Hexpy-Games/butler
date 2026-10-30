//! Bytes before the first output do not arm stall detection: response
//! headers alone, or a role-only chunk, then a prefill longer than the idle
//! limit, still end in one delivered answer.
use super::*;

/// Silence after the early bytes: past the idle limit, inside the total.
const SILENCE: Duration = Duration::from_millis(2_500);

async fn answered_once(id: &str, pace: Pace) -> Result<(), HarnessError> {
    let (server, s) = paced(id, pace, 6_000).await?;
    let ended = timed_turn(&s, PROMPT).await?;
    eprintln!(
        "{id}: {} after {:?}",
        turn_state(&ended.turn),
        ended.elapsed
    );
    assert_eq!(turn_state(&ended.turn), "delivered", "{}", ended.turn);
    assert_eq!(ended.text, ChatBehavior::default().answer);
    assert_eq!(rounds(&server), 1, "the round was resent");
    assert!(ended.elapsed >= SILENCE, "{:?}", ended.elapsed);
    s.finish().await
}

/// Headers at once, then nothing past the idle limit, then the answer.
#[tokio::test]
async fn headers_alone_do_not_arm_stall_detection() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    answered_once("FIRST-RESPONSE-07", Pace::HeadersThenSilence(SILENCE)).await
}

/// A role-only chunk at once, then nothing past the idle limit, then the
/// answer.
#[tokio::test]
async fn role_chunk_does_not_arm_stall_detection() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    answered_once("FIRST-RESPONSE-08", Pace::RoleChunkThenSilence(SILENCE)).await
}
