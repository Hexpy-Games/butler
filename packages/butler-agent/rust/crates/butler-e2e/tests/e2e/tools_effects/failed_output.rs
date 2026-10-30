use super::*;
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LocalCapabilities};

async fn command_output(
    case: &str,
    command: &str,
    timeout_ms: u64,
) -> Result<(Scenario, Value), HarnessError> {
    let server = FakeServer::local_models(ChatBehavior {
        script: vec![
            json!({"role":"assistant","content":null,"tool_calls":[{
                "id":"failed_command","type":"function","function":{
                    "name":"run_command","arguments":json!({
                        "command":command,"timeout_ms":timeout_ms,
                        "state_effect":"read_only","summary":"Run a command"
                    }).to_string()
                }
            }]}),
            json!({"role":"assistant","content":"The command failed."}),
        ],
        refuse_stream: true,
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["completion".into(), "tools".into()]),
            ..Default::default()
        },
        ..Default::default()
    })
    .await?;
    let s = crate::setup_local_models::with_local_server(case, &server).await?;
    crate::setup_local_models::use_local_model(&s, &server.base_url).await?;
    let turn_id = send(&s, "Run the command and report its failure.", "full_access").await?;
    let turn =
        s.gw.wait_terminal(
            "general",
            &turn_id,
            Duration::from_secs(butler_e2e::e2e::scenario::turn_timeout()),
        )
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let run = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "run_command")
        .expect("run_command row");
    assert_eq!(run["state"], "failed", "{run}");
    assert!(
        run["tool_result_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "{run}"
    );
    // operation_output requires HTTP 200 and verifies complete page coverage.
    let output = serde_json::from_str(&s.gw.operation_output(&turn_id, run).await?)?;
    Ok((s, output))
}

#[tokio::test]
async fn nonzero_exit_output_is_readable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, output) = command_output(
        "FAILED-COMMAND-OUTPUT",
        "echo failed-marker; exit 3",
        30_000,
    )
    .await?;
    assert_eq!(output["exit_code"], 3, "{output}");
    assert!(
        output["stdout"].as_str().unwrap().contains("failed-marker"),
        "{output}"
    );
    s.finish().await
}

#[tokio::test]
async fn timeout_output_is_readable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    // sleep accepts seconds in sh and is Start-Sleep's PowerShell alias.
    let (s, output) = command_output("TIMEOUT-COMMAND-OUTPUT", "sleep 2", 100).await?;
    assert_eq!(output["timed_out"], true, "{output}");
    s.finish().await
}
