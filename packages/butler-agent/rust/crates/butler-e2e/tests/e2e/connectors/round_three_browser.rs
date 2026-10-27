use super::round_two_access::attended;
use super::*;
use crate::browser_approval::host::Host;
use butler_e2e::e2e::scenario::Access;

fn commit() -> Value {
    json!({"name":"browser_act","arguments":{"tab":"acct","observation":"obs-1","steps":[{"action":"click","ref":"e6"},{"action":"type","value":"Complete source notes"},{"action":"click","ref":"e7"}]}})
}
fn navigate() -> Value {
    json!({"name":"browser_open","arguments":{"url":"https://shop.example.test/search?query=private-note"}})
}
async fn browser(spec: Value, tainted: bool, unattended: bool) -> Result<(), HarnessError> {
    let setup = setup("PC3-BROWSER")?.access(Access::FullAccess);
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    let host = Host::attach(&s).await?;
    if unattended {
        install(&s, &root).await?;
        let id = connect(&s, "immediate", 10.0).await?;
        account(&s, &id, "connected").await?;
        s.provider()?.set_chat_responder(stub::run);
        let mut injected = event("browser-injection");
        injected["snippet"] = format!("fixture-call:{spec}").into();
        emit(&s, &id, vec![injected]).await?;
        count(
            &s,
            "SELECT count(*) FROM turns WHERE state IN ('delivered','failed','cancelled')",
            1,
        )
        .await?;
        assert!(
            s.provider()?
                .requests()
                .iter()
                .any(|r| r.to_string().contains("schedule_permission_required")),
            "missing unattended refusal"
        );
    } else if tainted {
        let turn = attended(&s, spec.clone()).await?;
        assert_eq!(turn["state"], "waiting_for_form", "{turn}");
        let cards = serde_json::to_string(&s.gw.approval_requests("general").await?)?;
        assert!(cards.contains(spec["name"].as_str().unwrap()), "{cards}");
        if spec["name"] == "browser_open" {
            assert!(
                cards.contains("https://shop.example.test/search?query=private-note"),
                "{cards}"
            );
        } else {
            assert!(
                cards.contains("Post")
                    && cards.contains("https://account.example.test/")
                    && cards.contains("Complete source notes"),
                "{cards}"
            );
        }
    } else {
        invoke(
            &s,
            spec["name"].as_str().unwrap(),
            spec["arguments"].clone(),
        )
        .await?;
        assert_eq!(
            host.ops()
                .iter()
                .filter(|op| matches!(op.as_str(), "tab.act" | "tab.open"))
                .count(),
            1,
            "clean action must execute"
        );
    }
    if tainted {
        assert!(
            !host
                .ops()
                .iter()
                .any(|op| matches!(op.as_str(), "tab.act" | "tab.open")),
            "browser effect ran before approval"
        );
    }
    if unattended || !tainted {
        assert_eq!(
            s.gw.approval_requests("general").await?,
            Vec::<Value>::new()
        );
    }
    s.finish().await
}

#[tokio::test]
async fn round_three_connector_browser_commit_attended() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    browser(commit(), true, false).await
}
#[tokio::test]
async fn round_three_connector_browser_navigate_attended() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    browser(navigate(), true, false).await
}
#[tokio::test]
async fn round_three_connector_browser_commit_unattended() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    browser(commit(), true, true).await
}
#[tokio::test]
async fn round_three_connector_browser_navigate_unattended() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    browser(navigate(), true, true).await
}
#[tokio::test]
async fn round_three_clean_browser_commit() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    browser(commit(), false, false).await
}
#[tokio::test]
async fn round_three_clean_browser_navigate() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    browser(navigate(), false, false).await
}

#[tokio::test]
async fn round_three_connector_browser_deferred_steps_cannot_commit() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("PC3-BROWSER-DEFERRED")?
        .access(Access::FullAccess)
        .start()
        .await?;
    let host = Host::attach(&s).await?;
    let result = attended(&s, json!({"name":"browser_act","arguments":{"tab":"acct","observation":"obs-1","steps":[{"action":"type","value":"Draft"}]}})).await?;
    assert_eq!(result["state"], "waiting_for_form", "{result}");
    assert_eq!(host.acts(), Vec::<Value>::new());
    let cards = s.gw.approval_requests("general").await?;
    let reference = cards.first().unwrap()["request_ref"].as_str().unwrap();
    let allowed =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(allowed.status, 202);
    let terminal =
        s.gw.wait_terminal(
            "general",
            result["id"].as_str().unwrap(),
            Duration::from_secs(30),
        )
        .await?;
    assert_eq!(terminal["state"], "delivered", "{terminal}");
    let acts = host.acts();
    assert_eq!(acts.len(), 1);
    assert_eq!(
        acts[0]["commit_cleared"], false,
        "a focus-dependent submit still needs review"
    );
    s.finish().await
}

#[tokio::test]
async fn round_three_connector_browser_card_requires_one_time_consent() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    for spec in [commit(), navigate()] {
        let s = setup("PC3-BROWSER-ONE-TIME")?
            .access(Access::FullAccess)
            .start()
            .await?;
        let host = Host::attach(&s).await?;
        let result = attended(&s, spec).await?;
        assert_eq!(result["state"], "waiting_for_form", "{result}");
        let cards = s.gw.approval_requests("general").await?;
        let card = cards.first().unwrap();
        assert_eq!(
            card["approval"]["operation"]["allow_conversation"], false,
            "connector-origin effects require fresh consent: {card}"
        );
        assert!(
            !host
                .ops()
                .iter()
                .any(|op| matches!(op.as_str(), "tab.act" | "tab.open"))
        );
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn round_three_connector_browser_undeclared_effect_requires_card() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = setup("PC3-BROWSER-UNDECLARED")?
        .access(Access::FullAccess)
        .start()
        .await?;
    let host = Host::attach(&s).await?;
    let spec = json!({"name":"browser_act","arguments":{"tab":"pub","observation":"obs-1","steps":[{"action":"click","ref":"e8"}]}});
    let result = attended(&s, spec).await?;
    assert_eq!(result["state"], "waiting_for_form", "{result}");
    assert_eq!(
        host.acts(),
        Vec::<Value>::new(),
        "undeclared script-backed action executed"
    );
    let cards = serde_json::to_string(&s.gw.approval_requests("general").await?)?;
    assert!(cards.contains("Send"), "{cards}");
    s.finish().await
}
