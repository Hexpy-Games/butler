//! Earlier user messages remain available to resolve extraction references.
use super::*;
use butler_e2e::e2e::cassette::Cassette;

#[tokio::test]
async fn mem_extraction_sees_earlier_user_messages() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let messages = [
        "I ordered a pair of Atlas beetles.",
        "What bedding should they get?",
        "Thanks, noted.",
        "The new ones are Kipo and Rumi.",
    ];
    let mut cassette = Cassette::load("MEM-01")?;
    memory_stubs::extraction(&mut cassette, "")?;
    for message in messages {
        let mut answer = cassette.exchanges[1].clone();
        answer.request.key.round.clear();
        answer.request.key.user_request = message.into();
        for chunk in &mut answer.response.chunks {
            chunk.text = chunk.text.replace(
                "Saved your bike lock code to explicit memory for future conversations.",
                "Noted.",
            );
        }
        cassette.exchanges.push(answer);
    }
    let s = Setup::new("MEM-CONTEXT-REFERENCE")?
        .stub_cassette(cassette)
        .start()
        .await?;
    for message in messages {
        let (_, turn) = s.turn("general", message).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
    }
    memory_stubs::text_complete(&s.sandbox.data, 4).await?;
    let requests = s.provider()?.memory_requests();
    let (request, input) = requests
        .iter()
        .find_map(|request| {
            let text = request["input"]
                .as_str()
                .or_else(|| request["input"][0]["content"][0]["text"].as_str())?;
            let input: Value = serde_json::from_str(text).ok()?;
            (input["speaker"] == "user"
                && input["parts"]
                    .as_array()?
                    .iter()
                    .any(|part| part["text"] == messages[3]))
            .then_some((request, input))
        })
        .expect("t4 meaning request must be recorded");
    assert!(
        input["context"]
            .as_array()
            .unwrap()
            .iter()
            .any(|unit| unit["text"] == messages[0]),
        "t4 context is missing the earlier user description: {input}"
    );
    assert!(
        request["instructions"]
            .as_str()
            .unwrap()
            .contains("Use context to resolve references")
    );
    s.finish().await
}
