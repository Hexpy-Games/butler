use super::direct::Direct;
use super::*;

#[tokio::test]
async fn rejected_login_crashes_account_after_three_attempts_without_leaking_password()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    fake.reject_login(true);
    let setup = setup("MAIL-REJECTED-LOGIN")?;
    let root = package(&setup.sandbox.home)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let password = format!("mail-auth-canary-{}", uuid::Uuid::new_v4());
    let response = api(
        &s,
        Method::POST,
        "/connectors/mail/mail/accounts",
        Some(json!({
            "fields": fields(&fake),
            "secrets": {"IMAP_PASSWORD": password},
            "handling": {"mode": "batch", "interval_minutes": 0.025},
            "revision": revision(&s).await?
        })),
    )
    .await?;
    assert_eq!(response.status, 200, "mail account creation failed");
    let id = response.data()["account"]
        .as_str()
        .ok_or_else(|| HarnessError("mail account id missing".into()))?
        .to_owned();

    wait(|| async {
        let response = api(&s, Method::GET, "/connectors", None).await?;
        Ok(account_has_state(&response, &id, "crashed"))
    })
    .await?;
    assert_eq!(login_attempts(&fake), 3, "unexpected LOGIN attempt count");
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert_eq!(
        login_attempts(&fake),
        3,
        "LOGIN continued after crash limit"
    );

    let connectors = api(&s, Method::GET, "/connectors", None).await?;
    assert_eq!(connectors.status, 200, "connector inventory request failed");
    assert!(
        !connectors.text.contains(&password),
        "password canary leaked to GET /connectors"
    );
    assert!(
        !s.agent.logs().contains(&password),
        "password canary leaked to agent logs"
    );
    assert!(
        !fake.commands().join("\n").contains(&password),
        "password canary leaked to fake IMAP command log"
    );

    let action_fake = FakeImap::start().await?;
    action_fake.reject_login(true);
    let action = Direct::open(&s, &action_fake, &id, &password).await?;
    let result = action
        .call("search", json!({"query":"ALL","limit":10}))
        .await?;
    assert!(result["isError"].as_bool().unwrap_or(false));
    assert!(
        result["content"][0]["text"].as_str() == Some("mail_auth_failed"),
        "action did not return the fixed authentication error"
    );
    assert!(
        !result.to_string().contains(&password),
        "password canary leaked to action result"
    );
    action.close(&password).await?;
    assert_eq!(
        login_attempts(&action_fake),
        1,
        "action retried rejected LOGIN"
    );

    let exit_fake = FakeImap::start().await?;
    exit_fake.reject_login(true);
    let connector = Direct::open(&s, &exit_fake, &id, &password).await?;
    let (status, stderr) = connector.subscribe_until_exit(&password).await?;
    assert!(
        !status.success(),
        "rejected LOGIN did not fail the connector process"
    );
    assert!(
        stderr.trim() == "mail_auth_failed",
        "connector stderr was not fixed"
    );
    assert_eq!(
        login_attempts(&exit_fake),
        1,
        "connector retried rejected LOGIN"
    );

    s.finish().await
}

fn account_has_state(response: &butler_e2e::e2e::gateway::Reply, id: &str, state: &str) -> bool {
    response.data()["connectors"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|connector| connector["accounts"].as_array().into_iter().flatten())
        .any(|account| account["id"] == id && account["state"] == state)
}

fn login_attempts(fake: &FakeImap) -> usize {
    fake.commands()
        .iter()
        .filter(|command| command.ends_with(" LOGIN [redacted]"))
        .count()
}
