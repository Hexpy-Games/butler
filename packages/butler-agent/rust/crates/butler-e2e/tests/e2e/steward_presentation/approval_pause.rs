//! Exercise parent steering while a child is idle at a real approval card.
use super::*;
use butler_e2e::e2e::scenario::Scenario;

pub(crate) async fn pending(s: &Scenario) -> Result<(String, Value), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        for (session, request) in requests(s).await? {
            if request["executable"] == "read_file" {
                return Ok((session, request));
            }
        }
        assert!(
            Instant::now() < deadline,
            "child never paused for approval\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn requests(s: &Scenario) -> Result<Vec<(String, Value)>, HarnessError> {
    Ok(s.gw
        .approval_requests("general")
        .await?
        .into_iter()
        .map(|request| ("general".to_owned(), request))
        .collect())
}

pub(crate) async fn allow(
    s: &Scenario,
    session: &str,
    request: &Value,
) -> Result<(), HarnessError> {
    let reference = request["request_ref"]
        .as_str()
        .or_else(|| request["ref"].as_str())
        .unwrap();
    let allowed =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id={session}"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(allowed.status, 202, "{allowed:?}");
    Ok(())
}

pub(crate) async fn drive<T>(
    s: &Scenario,
    future: impl std::future::Future<Output = Result<T, HarnessError>>,
) -> Result<T, HarnessError> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            result = &mut future => return result,
            result = approve_next(s) => result?,
        }
    }
}

async fn approve_next(s: &Scenario) -> Result<(), HarnessError> {
    for (session, request) in requests(s).await? {
        allow(s, &session, &request).await?;
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    Ok(())
}

pub(crate) async fn held(s: &Scenario, script: &stub::Script) -> Result<(), HarnessError> {
    drive(s, async {
        tokio::time::timeout(Duration::from_secs(20), script.held.notified())
            .await
            .expect("child never reached the provider barrier");
        Ok(())
    })
    .await
}

/// A dispatcher may win the claim before the synchronous send returns.
pub(crate) async fn turn_id(s: &Scenario, text: &str) -> Result<String, HarnessError> {
    let sent = s.gw.say("general", text).await?;
    if let Ok(id) = butler_e2e::e2e::scenario::accepted_turn_id(&sent) {
        return Ok(id);
    }
    assert!(sent["queued"]["id"].is_string(), "{sent}");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(message) =
            s.gw.messages("general")
                .await?
                .iter()
                .find(|m| m["role"] == "user" && m["text"] == text)
        {
            return Ok(message["turn_id"].as_str().unwrap().into());
        }
        assert!(
            Instant::now() < deadline,
            "parent message did not start
{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
