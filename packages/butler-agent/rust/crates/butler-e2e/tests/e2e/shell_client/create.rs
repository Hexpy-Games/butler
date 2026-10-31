//! New-chat ingress through the authenticated native client.
use super::*;

#[tokio::test]
async fn create_chat_send_and_read_its_session() -> Result<(), TestError> {
    butler_e2e::gate!();
    let s = start("SHELL-CREATE", 0, Access::FullAccess).await?;
    let client = attach(&s).await?;
    let created = client.create_session(Some("New chat")).await?;
    let session = created["session"]["id"].as_str().unwrap();
    let untitled = client.create_session(None).await?;
    assert!(untitled["session"]["title"].is_string());
    assert_ne!(untitled["session"]["id"], created["session"]["id"]);
    let controls = client.session_controls(session).await?;
    assert_eq!(controls["controls"]["access_mode"], "full_access");
    assert!(controls["controls"]["model"].is_string());
    let page = client.list_sessions(PageRequest::new(200, None)?).await?;
    assert!(page.items.iter().any(|row| row["id"] == session));
    let mut live = client.live_events(page.event_cursor);
    let sent = client
        .post_message(session, "first-message", "Reply briefly")
        .await?;
    let turn = s.gw.accepted_turn(&sent).await?;
    tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(event) = live.next().await {
            if delivered(&event?.raw, &turn) {
                return Ok::<_, TestError>(());
            }
        }
        Err("stream ended".into())
    })
    .await??;
    let window = client.message_window(session, None, 200).await?;
    assert_eq!(window["messages"].as_array().unwrap().len(), 2);
    assert_eq!(window["messages"][1]["text"], "shell answer");
    drop(live);
    Ok(s.finish().await?)
}
