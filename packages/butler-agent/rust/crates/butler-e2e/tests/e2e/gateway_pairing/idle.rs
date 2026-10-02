use super::helpers::*;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::{Connection, OpenFlags};
use std::{
    path::Path,
    time::{Duration, SystemTime},
};

fn version(db: &Connection) -> u64 {
    db.pragma_query_value(None, "data_version", |row| row.get(0))
        .unwrap()
}
fn seen(db: &Connection, id: &str) -> u64 {
    db.query_row(
        "SELECT last_seen_at FROM paired_devices WHERE id=?1",
        [id],
        |row| row.get(0),
    )
    .unwrap()
}

fn stamps(data: &Path) -> Vec<Option<(u64, SystemTime)>> {
    ["butler-client.sqlite", "butler-client.sqlite-wal"]
        .iter()
        .map(
            |name| match std::fs::metadata(data.join("app-server").join(name)) {
                Ok(meta) => Some((meta.len(), meta.modified().unwrap())),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => panic!("cannot inspect isolated database: {error}"),
            },
        )
        .collect()
}

#[tokio::test]
async fn paired_devices_have_zero_idle_writes_and_request_driven_last_seen()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SSD-PAIRED")?
        .data_folder_token()
        .start()
        .await?;
    let app = admin(&s);
    let browser = browser();
    let mut cookies = Vec::new();
    for _ in 0..3 {
        let pin = issue(&app).await?;
        let response = connect(&s.gw, &browser, pin["code"].as_str().unwrap()).await?;
        assert_eq!(response.status().as_u16(), 303);
        cookies.push(cookie_pair(&response));
    }
    let before_list = devices(&app).await?;
    assert_eq!(before_list.as_array().unwrap().len(), 3);
    let id = cookies[0].split('.').nth(1).unwrap();
    let db = Connection::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("open isolated App DB");
    let initial_seen = seen(&db, id);
    tokio::time::sleep(Duration::from_secs(2)).await;
    let before = version(&db);
    let before_stamps = stamps(&s.sandbox.data);
    advance(&app, 901).await?;
    let io_before = butler_platform::process_control::usage::sample(s.agent.pid().unwrap())?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(version(&db), before, "paired idle App DB writes");
    assert_eq!(
        stamps(&s.sandbox.data),
        before_stamps,
        "idle buffered database/WAL writes"
    );
    let io_after = butler_platform::process_control::usage::sample(s.agent.pid().unwrap())?;
    if let Some((before, after)) = io_before.zip(io_after) {
        assert_eq!(
            after.write_bytes - before.write_bytes,
            0,
            "idle storage writes"
        );
        // wchar includes Tokio's eventfd notifications, not only storage.
    }
    assert_eq!(seen(&db, id), initial_seen);
    assert_eq!(
        devices(&app).await?,
        before_list,
        "idle device state changed"
    );
    assert_eq!(read(&s.gw, &browser, &cookies[0]).await?, 200);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while seen(&db, id) == initial_seen {
        assert!(
            tokio::time::Instant::now() < deadline,
            "last seen not persisted"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(seen(&db, id) >= initial_seen + 900);
    let touched = version(&db);
    for cookie in &cookies {
        assert_eq!(read(&s.gw, &browser, cookie).await?, 200);
    }
    // Other devices cross the boundary once, then repeated requests stay in memory.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let settled = version(&db);
    for cookie in &cookies {
        assert_eq!(read(&s.gw, &browser, cookie).await?, 200);
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(version(&db), settled, "last-seen wrote inside 15 minutes");
    assert!(settled >= touched);
    assert_eq!(devices(&app).await?.as_array().unwrap().len(), 3);
    eprintln!(
        "SSD-PAIRED devices=3 virtual_idle=901s idle_commits=0 idle_write_bytes=0 buffered_database_writes=0 request_interval=900s"
    );
    drop(db);
    s.finish().await
}
