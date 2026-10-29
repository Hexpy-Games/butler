//! An invalid request stays a per-file result and the model can finish its turn.
use super::{
    capability_stub::{self as provider, Case},
    observation_stub,
};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Setup},
};
use serde_json::json;

#[tokio::test]
async fn invalid_path_batch_preserves_good_file_and_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for access in [Access::FullAccess, Access::AskAlways] {
        let setup = Setup::new("INVALID-PATH-BATCH")?;
        let good = setup.sandbox.home.join("good.txt");
        std::fs::write(&good, "complete good file\n")?;
        let case = Case {
            tool: "read_file",
            refused: false,
            args: json!({"requests":[{"path":"bad\0path.txt"},{"path":good}]}),
        };
        let (url, script, server) = provider::start(case.clone()).await?;
        let s = setup
            .stub_cassette(observation_stub::cassette()?)
            .access(access)
            .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
            .start()
            .await?;
        let accepted = s.gw.say("general", provider::PROMPT).await?;
        let id = s.gw.accepted_turn(&accepted).await?;
        if access == Access::AskAlways {
            approve_batch(&s, &id, &case).await?;
        }
        let turn =
            s.gw.wait_terminal("general", &id, std::time::Duration::from_secs(15))
                .await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        let output = script
            .result
            .lock()
            .unwrap()
            .clone()
            .expect("model receives batch result")
            .0;
        assert_eq!(output["files"].as_array().unwrap().len(), 2, "{output}");
        assert_eq!(output["files_read"], 1, "{output}");
        assert_eq!(output["files"][0]["error"], "invalid_path", "{output}");
        assert_eq!(output["files"][0]["path"], "bad\0path.txt");
        assert_eq!(output["files"][1]["ok"], true, "{output}");
        assert_eq!(output["files"][1]["content"], "complete good file\n");
        assert_eq!(output["truncated"], false, "{output}");
        s.finish().await?;
        server.abort();
    }
    Ok(())
}

async fn approve_batch(
    s: &butler_e2e::e2e::scenario::Scenario,
    id: &str,
    case: &Case,
) -> Result<(), HarnessError> {
    let turn =
        s.gw.wait_turn(
            "general",
            id,
            &["waiting_for_form", "delivered", "failed"],
            std::time::Duration::from_secs(15),
        )
        .await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    let cards = s.gw.approval_requests("general").await?;
    let card = cards.iter().find(|c| c["source_turn_id"] == id).unwrap();
    assert_eq!(
        card["approval"]["examples"],
        json!([
            case.args["requests"][0]["path"],
            case.args["requests"][1]["path"]
        ])
    );
    let reply =
        s.gw.post(
            &format!(
                "/authority-requests/{}/allow?session_id=general",
                card["request_ref"].as_str().unwrap()
            ),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    Ok(())
}
