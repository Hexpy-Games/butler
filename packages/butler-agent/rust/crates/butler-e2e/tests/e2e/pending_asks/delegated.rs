use super::*;
use butler_e2e::e2e::scenario::Access;

#[tokio::test]
async fn pa_03_steward_approval_is_listed_under_the_owner_chat() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = crate::steward_presentation::stub::start().await?;
    let setup = crate::steward_presentation::setup("PA-03", &url)?.access(Access::AskAlways);
    std::fs::write(setup.sandbox.data.join("a.txt"), "Approach A")?;
    std::fs::write(setup.sandbox.data.join("b.txt"), "Approach B")?;
    *script.workspace.lock().unwrap() = setup.sandbox.data.to_string_lossy().into_owned();
    let s = setup.start().await?;
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let (_, parent) = s
        .turn("general", crate::steward_presentation::stub::OWNER)
        .await?;
    assert_eq!(turn_state(&parent), "delivered", "{parent}");
    live.wait_for(Duration::from_secs(20), |e| {
        e["type"] == "pending_asks.changed"
            && e["payload"]["kind"] == "approval"
            && e["payload"]["state"] == "open"
    })
    .await?;
    let page = asks(&s, "general").await?;
    assert_eq!(page["open_count"], 1, "{page}");
    let approval = &page["asks"][0];
    assert_eq!(approval["kind"], "approval");
    assert_eq!(approval["session_id"], "general");
    let view = s.gw.get("/session-view?session_id=general").await?;
    let child = &view.data()["steward_children"][0];
    assert_eq!(approval["source_session_id"], child["session_id"]);
    assert_fields(
        &s,
        child["session_id"].as_str().unwrap(),
        approval,
        false,
        Some("read_file"),
    )
    .await?;
    assert_eq!(approval["blocking"], true);
    let global = s.gw.get("/pending-asks").await?;
    assert_eq!(global.data()["asks"][0]["ask_id"], approval["ask_id"]);
    script.release.notify_one();
    server.abort();
    s.finish().await
}
