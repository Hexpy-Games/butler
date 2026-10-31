//! A branched conversation's SessionStart hook adds to the branch's own first turn.
use super::*;

#[tokio::test]
async fn branched_session_start_goes_with_the_branch_first_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior {
        answer: "Loam is a common type of garden soil.".into(),
        chunk_delay: Duration::from_millis(5),
        ..ChatBehavior::default()
    })
    .await?;
    let s = start("BRANCH-HOOK", &server).await?;
    let (_, chat, answer) = branch_source(&s).await?;
    let text = "HOOK-BRANCH-TEXT";
    let command = if butler_platform::command_sandbox::POSIX_SHELL {
        format!("printf {text}")
    } else {
        format!("echo {text}")
    };
    std::fs::write(
        s.sandbox.data.join("hooks.json"),
        json!({"version":1,"hooks":[{"id":"branched","event":"SessionStart","type":"command",
            "command":command,"timeout_ms":10000}]})
        .to_string(),
    )?;
    let reply =
        s.gw.post(
            "/space/branches",
            branch_body(
                &chat,
                &answer,
                "branch-hook",
                "Beds",
                &json!({"kind": "chat"}),
            ),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let branch = reply.data()["session"]["id"].as_str().unwrap().to_owned();
    let seen = server.chat_requests().len();
    assert_eq!(
        s.turn(&branch, "First in the branch.").await?.1["state"],
        "delivered"
    );
    let requests = server.chat_requests();
    let first = requests[seen..]
        .iter()
        .map(ToString::to_string)
        .find(|request| request.contains("First in the branch."))
        .expect("the branch's first turn asked the model");
    assert_eq!(first.matches(text).count(), 1, "{first}");
    assert!(first.contains("event=SessionStart"), "{first}");
    // The source conversation got none of it.
    let seen = server.chat_requests().len();
    assert_eq!(
        s.turn(&chat, "Back in the source.").await?.1["state"],
        "delivered"
    );
    assert!(
        server.chat_requests()[seen..]
            .iter()
            .all(|request| !request.to_string().contains(text)),
        "the branch's text reached its source"
    );
    s.finish().await
}
