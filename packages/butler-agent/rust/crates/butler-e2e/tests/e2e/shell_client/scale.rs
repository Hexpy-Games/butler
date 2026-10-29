//! Owner-scale bounded reads and reconcile replay through the public gateway.
use super::*;
use butler_platform::sqlite;
use std::time::Instant;

fn seed(data: &std::path::Path) -> Result<(), TestError> {
    let db = sqlite::open(data.join("app-server/butler-client.sqlite"))?;
    db.execute_batch(
        "BEGIN;
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<600)
         INSERT INTO chats(id,title,kind,pinned,archived,created_at,updated_at)
         SELECT printf('shell-%04d',i),printf('Chat %04d',i),'chat',0,0,
                '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM n;
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1200)
         INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at)
         SELECT printf('shell-m-%04d',i),'shell-0600','user',printf('complete message %04d',i),
                'delivered','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM n;
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<300000)
         INSERT INTO events(type,payload_json,created_at)
         SELECT 'future.shell_event',json_object('ordinal',i,'text','complete payload'),'2026-01-01T00:00:00.000Z' FROM n;
         COMMIT;"
    )?;
    Ok(())
}

#[tokio::test]
async fn owner_scale_paging_and_reconcile_are_complete() -> Result<(), TestError> {
    butler_e2e::gate!();
    let mut s = start("SHELL-SCALE", 0, Access::FullAccess).await?;
    s.agent.terminate().await?;
    seed(&s.sandbox.data)?;
    s.restart().await?;
    let client = attach(&s).await?;
    let began = Instant::now();
    let mut chats = Vec::new();
    let mut offset = 0;
    loop {
        let page = client.list_chats(PageRequest::new(100, offset)?).await?;
        assert!(page.items.len() <= 100);
        chats.extend(page.items);
        let Some(next) = page.next_offset else {
            break;
        };
        offset = next;
    }
    let seeded: Vec<_> = chats
        .iter()
        .filter_map(|v| v["id"].as_str())
        .filter(|id| id.starts_with("shell-"))
        .collect();
    let expected: Vec<_> = (0..=600).rev().map(|i| format!("shell-{i:04}")).collect();
    assert_eq!(seeded, expected);
    let lists_elapsed = began.elapsed();
    let began = Instant::now();
    let latest = client.message_window("shell-0600", None, 200).await?;
    assert_eq!(latest["messages"].as_array().unwrap().len(), 200);
    assert_eq!(
        latest["messages"].as_array().unwrap().last().unwrap()["text"],
        "complete message 1200"
    );
    assert_eq!(
        latest["messages"].as_array().unwrap().last().unwrap()["status"],
        "delivered"
    );
    let latest_elapsed = began.elapsed();
    let mut window = latest;
    let mut count = 0;
    let mut high = 1201;
    loop {
        let messages = window["messages"].as_array().unwrap();
        assert!(messages.len() <= 200);
        let first = high - messages.len();
        for (index, message) in messages.iter().enumerate() {
            assert_eq!(
                message["text"],
                format!("complete message {:04}", first + index)
            );
        }
        count += messages.len();
        high = first;
        if !window["message_window"]["has_more"].as_bool().unwrap() {
            break;
        }
        window = client
            .message_window(
                "shell-0600",
                window["message_window"]["previous_cursor_token"].as_str(),
                200,
            )
            .await?;
    }
    assert_eq!(count, 1200);
    // The live endpoint's replay cap forces reconcile; the client must recover
    // every retained event in bounded pages, including unknown event types.
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let first: u64 = db.query_row(
        "SELECT MIN(id) FROM events WHERE type='future.shell_event'",
        [],
        |r| r.get(0),
    )?;
    let mut stream = client.live_events(first + 299_499);
    let began = Instant::now();
    let mut seen = 0;
    tokio::time::timeout(Duration::from_secs(30), async {
        while seen < 500 {
            let event = stream.next().await.unwrap().unwrap();
            assert_eq!(event.cursor, Some(first + 299_500 + seen));
            assert_eq!(event.raw["payload"]["ordinal"], 299_501 + seen);
            assert_eq!(event.raw["payload"]["text"], "complete payload");
            assert_eq!(
                event.kind,
                butler_shell_client::EventKind::Unknown("future.shell_event".into())
            );
            seen += 1;
        }
    })
    .await?;
    let replay_elapsed = began.elapsed();
    eprintln!(
        "SHELL-SCALE chats={} list={lists_elapsed:?} messages={count} latest={latest_elapsed:?} events=300000 recovered={seen} replay={replay_elapsed:?}",
        chats.len()
    );
    butler_e2e::assert_wall_clock_budget!(
        lists_elapsed,
        Duration::from_secs(5),
        "shell chat pages"
    );
    butler_e2e::assert_wall_clock_budget!(
        latest_elapsed,
        Duration::from_secs(2),
        "shell latest messages"
    );
    butler_e2e::assert_wall_clock_budget!(
        replay_elapsed,
        Duration::from_secs(5),
        "shell cursor recovery"
    );
    drop(stream);
    s.finish().await?;
    Ok(())
}
