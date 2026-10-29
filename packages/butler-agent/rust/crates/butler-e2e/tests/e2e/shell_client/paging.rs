//! Small paging scenarios keep the Electron wire contract and a stable traversal.
use super::*;

#[tokio::test]
async fn updated_page_two_chat_is_returned_once_in_snapshot_order() -> Result<(), TestError> {
    butler_e2e::gate!();
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let clock = listener.local_addr()?.to_string();
    drop(listener);
    let s = Setup::new("SHELL-PAGES")?
        .data_folder_token()
        .access(Access::FullAccess)
        .env("BUTLER_APP_SERVER_PORT", "0")
        .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &clock)
        .synthetic(Script {
            rounds: 0,
            path_for: Box::new(|_| "unused".into()),
            final_text: "answer".into(),
        })
        .start()
        .await?;
    for title in ["one", "two", "three", "four", "five"] {
        assert_eq!(
            s.gw.post("/sessions", json!({"kind":"chat","title":title}))
                .await?
                .status,
            201
        );
    }
    let client = attach(&s).await?;
    for (sessions, now) in [
        (false, "2026-09-28T00:00:00Z"),
        (true, "2026-09-29T00:00:00Z"),
    ] {
        check_pages(&s, &client, sessions, &clock, now).await?;
    }
    s.finish().await?;
    Ok(())
}

async fn page(
    client: &ShellClient,
    sessions: bool,
    cursor: Option<String>,
) -> Result<butler_shell_client::Page, TestError> {
    let request = PageRequest::new(2, cursor)?;
    Ok(if sessions {
        client.list_sessions(request).await?
    } else {
        client.list_chats(request).await?
    })
}

async fn check_pages(
    s: &Scenario,
    client: &ShellClient,
    sessions: bool,
    clock: &str,
    now: &str,
) -> Result<(), TestError> {
    let route = if sessions { "/sessions" } else { "/chats" };
    let baseline = s.gw.get(route).await?;
    let first = page(client, sessions, None).await?;
    // Bounded reads must not alter Electron's unpaged bytes or envelope shape.
    assert_eq!(s.gw.get(route).await?.text, baseline.text);
    let rows = if sessions {
        baseline.data()["sessions"].as_array().unwrap()
    } else {
        baseline.data().as_array().unwrap()
    };
    assert_eq!(rows.len(), 6);
    let changed = rows[3]["id"].as_str().unwrap();
    crate::chats_initiated::support::clock(clock, now).await?;
    assert_eq!(
        s.gw.patch(
            &format!("/sessions/{changed}"),
            json!({"title":"updated page two"})
        )
        .await?
        .status,
        200
    );
    let latest = s.gw.get(route).await?;
    let latest = if sessions {
        &latest.data()["sessions"]
    } else {
        latest.data()
    };
    assert_eq!(
        latest[0]["id"], changed,
        "the update really moved a page-2 item before the cursor"
    );
    let mut items = first.items;
    let mut cursor = first.next_cursor;
    assert!(cursor.is_some());
    while let Some(next) = cursor.take() {
        let next = page(client, sessions, Some(next)).await?;
        items.extend(next.items);
        cursor = next.next_cursor;
    }
    assert!(cursor.is_none());
    assert_eq!(items.len(), rows.len());
    assert_eq!(
        items.iter().map(|v| &v["id"]).collect::<Vec<_>>(),
        rows.iter().map(|v| &v["id"]).collect::<Vec<_>>()
    );
    assert_eq!(
        items.iter().find(|v| v["id"] == changed).unwrap()["title"],
        "updated page two"
    );
    Ok(())
}
