//! Tool arguments written as reply text.
use super::*;

/// A tool name followed by its JSON arguments in the reply text is a call
/// written as text: it is not delivered as the answer, and the model is told
/// to use the native call.
#[tokio::test]
async fn tool_arguments_written_as_text_receive_feedback() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup(stub::Mode::JsonProse, Access::FullAccess).await?;
    let (_, turn) = s.turn("general", stub::REQUEST).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let messages = s.gw.messages("general").await?;
    let answer = messages.iter().find(|m| m["role"] == "assistant").unwrap()["text"]
        .as_str()
        .unwrap();
    assert_eq!(answer, "The total is 42.");
    let requests = script.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1]
            .to_string()
            .contains("You wrote these tool names as text: read_file."),
        "{}",
        requests[1]
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
