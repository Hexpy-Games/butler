use super::*;

/// SHELL-APP-30 — First run: the API key cards are the catalog's hosted providers; a key the provider refuses shows the field error with no spinner, and Back returns to the list with no spinner.
#[tokio::test]
async fn shell_app_30_onboarding_providers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let provider = FakeServer::provider_models().await?;
    let mut sandbox = Sandbox::new("SHELL-APP-30")?;
    let api = format!("{}/v1", provider.base_url);
    let env = [("BUTLER_ANTHROPIC_BASE_URL", api)];
    let mut shell = Shell::start(&sandbox, &env).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor first-run-start",
            "click first-run-start",
            "wait-anchor first-run-agree",
            "click first-run-agree",
            "wait-anchor first-run-memory-off",
            "click first-run-memory-off",
            "wait-anchor first-run-memory-continue",
            "click first-run-memory-continue",
            "wait-anchor first-run-card-claude",
            "wait-anchor first-run-more-toggle",
            "click first-run-more-toggle",
        ])
        .await?;

    let gw = gateway(&shell.launch);
    let catalog = gw.get("/model-catalog").await?;
    let hosted = catalog.data()["providers"]
        .as_array()
        .expect("catalog providers")
        .iter()
        .map(|p| p["provider_id"].as_str().expect("provider id"))
        .filter(|id| *id != "local")
        .collect::<Vec<_>>();
    assert!(!hosted.is_empty());
    for id in hosted {
        shell
            .run(&[&format!("expect-anchor first-run-key-card-{id}")])
            .await?;
    }

    shell
        .run(&[
            "wait-anchor first-run-card-claude",
            "click first-run-card-claude",
            "wait-anchor first-run-key-field",
            "wait-anchor first-run-api-key",
            "click first-run-api-key",
            "type sk-e2e-refused-0003",
            "wait-anchor first-run-key-error",
            "expect-no-anchor first-run-key-spinner",
            "wait-anchor setup-wizard-step-back",
            "click setup-wizard-step-back",
            "wait-anchor first-run-card-claude",
            "wait-no-anchor first-run-prep-spinner",
            "expect-no-anchor first-run-key-spinner",
            "expect-no-anchor first-run-key-error",
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
