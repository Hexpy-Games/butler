use super::*;
use std::sync::atomic::Ordering;
#[tokio::test]
async fn queue_edits_cas_and_running_pin() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) = crate::canon_link::setup("CB-CAS", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.quick.store(true, Ordering::SeqCst);
    let view = data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    let path = format!("/sessions/{chat}/canon/queue/edits");
    let conflict =
        s.gw.post(
            &path,
            json!({"expected_graph_revision":0,"op":"delete","epic_id":epics[2]}),
        )
        .await?;
    assert_eq!(conflict.status, 409, "{}", conflict.text);
    assert_eq!(conflict.body["graph_revision"], view["graph_revision"]);
    data(s.gw.post(&path,json!({"expected_graph_revision":view["graph_revision"],"op":"join_stack","epic_id":epics[2],"target_epic_id":epics[1]})).await?,200);
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert_eq!(
        view["chains"][0]["steps"][1]["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let pinned =
        s.gw.post(
            &path,
            json!({"expected_graph_revision":view["graph_revision"],"op":"delete","epic_id":first}),
        )
        .await?;
    assert_eq!(pinned.status, 400, "{}", pinned.text);
    s.finish().await?;
    server.abort();
    Ok(())
}
