//! Uses the canon-link stub's held real Work, not a synthetic running flag.
use super::*;
use crate::canon_mcp::{call, trust};
#[tokio::test]
async fn cn_11_mcp_running_guard_applies_to_every_caller() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, id, chat) = setup("CN-11-RUNNING", false, false).await?;
    trust(&s).await?;
    let turn = s.gw.say(&chat, "Process the release epic").await?;
    script.wait_held().await;
    assert_eq!(progress(&s, &id).await?["running"], true);
    let epic = call(&s, "canon_get_epic", json!({"epic_id":id})).await?;
    let input = json!({"epic_id":id,"expected_revision":epic["revision"],"status":"done"});
    assert_eq!(
        call(&s, "canon_update_epic_status", input).await?["error"]["code"],
        "running"
    );
    let reply =
        s.gw.patch(
            &format!("/canon/epics/{id}"),
            json!({"expected_revision":epic["revision"],"status":"done"}),
        )
        .await?;
    assert_eq!(reply.status, 409);
    assert_eq!(reply.error_code(), Some("running"));
    script.release();
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&turn).await?,
        Duration::from_secs(60),
    )
    .await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
