//! The public child view shows the delegated request without model-only plan lines.
use super::stub;
use butler_e2e::e2e::{HarnessError, scenario::Scenario};

pub(super) async fn assert_delivered_messages(
    s: &Scenario,
    child_id: &str,
) -> Result<(), HarnessError> {
    let view =
        s.gw.get(&format!("/session-view?session_id={child_id}"))
            .await?;
    let request = view.data()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "user")
        .and_then(|message| message["text"].as_str())
        .unwrap()
        .to_owned();
    assert!(request.starts_with(stub::OWNER), "{request}");
    for line in ["Goal:", "Deliver:", "Next:", "Assumed:", "role: steward"] {
        assert!(!request.contains(line), "{request}");
    }
    Ok(())
}

use std::time::{Duration, Instant};

pub(super) async fn assert_sidebar_work(
    s: &butler_e2e::e2e::scenario::Scenario,
    running: bool,
) -> Result<(), HarnessError> {
    let navigation = s.gw.get("/navigation").await?;
    let parent = navigation.data()["chats"]
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["id"] == "general")
        .unwrap();
    assert_eq!(parent["running_delegated_work"], running, "{parent}");
    Ok(())
}

pub(super) async fn assert_history_sidebar(
    s: &butler_e2e::e2e::scenario::Scenario,
) -> Result<(), HarnessError> {
    let db =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    db.execute_batch(
        "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<7)
        INSERT INTO chats(id,title,kind,created_at,updated_at)
        SELECT 'busy-scale-'||i,'Idle chat '||i,'chat','2026-01-01','2026-01-01' FROM n;",
    )
    .unwrap();
    let started = Instant::now();
    let navigation = s.gw.get("/navigation").await?;
    let elapsed = started.elapsed();
    let chats = navigation.data()["chats"].as_array().unwrap();
    assert_eq!(chats.len(), 9, "complete navigation with retained history");
    assert_eq!(
        chats
            .iter()
            .filter(|chat| chat["running_delegated_work"] == true)
            .count(),
        1
    );
    assert!(
        chats
            .iter()
            .any(|chat| chat["id"] == "general" && chat["running_delegated_work"] == true)
    );
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_millis(500),
        "9-chat delegated navigation"
    );
    println!(
        "9-chat complete delegated navigation: {} ms",
        elapsed.as_millis()
    );
    Ok(())
}
