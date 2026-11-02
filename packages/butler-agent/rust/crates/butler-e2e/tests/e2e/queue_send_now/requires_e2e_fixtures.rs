//! Holds native cancellation after the App has persisted its durable outbox.
//! Stop must also persist while another connection holds the BTCC write lock.
use super::*;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::mpsc,
};

struct Barrier {
    events: mpsc::UnboundedReceiver<TcpStream>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Barrier {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Barrier {
    async fn start() -> (Self, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let (tx, events) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stream);
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    if line.starts_with("stop_persist\t") {
                        tx.send(reader.into_inner()).unwrap();
                    } else {
                        reader.into_inner().write_all(b"1").await.unwrap();
                    }
                });
            }
        });
        (Self { events, server }, address)
    }
    async fn held(&mut self) -> TcpStream {
        tokio::time::timeout(Duration::from_secs(30), self.events.recv())
            .await
            .unwrap()
            .unwrap()
    }
}

fn stop_fault_lines(logs: &str, turn_id: &str) -> Vec<String> {
    logs.lines()
        .filter(|line| line.contains(turn_id) && line.contains("e2e stop write fault"))
        .map(str::to_owned)
        .collect()
}

fn outbox_state(db: &rusqlite::Connection, turn_id: &str) -> rusqlite::Result<String> {
    db.query_row(
        "SELECT state FROM app_turn_cancel_outbox WHERE turn_id=?1",
        [turn_id],
        |row| row.get(0),
    )
}

fn native_state(db: &rusqlite::Connection, turn_id: &str) -> rusqlite::Result<String> {
    db.query_row(
        "SELECT semantic_state FROM btcc_turns WHERE turn_id=?1",
        [turn_id],
        |row| row.get(0),
    )
}

fn stop_request_count(db: &rusqlite::Connection, turn_id: &str) -> rusqlite::Result<usize> {
    db.query_row(
        "SELECT count(*) FROM btcc_stop_requests WHERE turn_id=?1",
        [turn_id],
        |row| row.get(0),
    )
}

fn stop_diagnostic(
    app_state: &str,
    outbox: &str,
    native: &str,
    stop_requests: usize,
    fault_lines: &[String],
) -> String {
    format!(
        "App turn state={app_state:?}, outbox state={outbox:?}, native semantic_state={native:?}, btcc_stop_requests={stop_requests}, matching log lines={fault_lines:?}"
    )
}

#[tokio::test]
async fn restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut stub, setup) = Stub::setup().await?;
    let (mut barrier, address) = Barrier::start().await;
    let mut s = setup.env("BUTLER_TEST_PAUSE_ADDR", address).start().await?;
    stub.attach(&s)?;
    let running = s.gw.say_turn("general", ORIGINAL).await?;
    let held = stub.next().await;
    let correction = queue(&s, CORRECTION).await?;
    queue(&s, SECOND).await?;
    sent(&s, &correction).await?;
    let cancelling = barrier.held().await;
    let turn = s.gw.turn("general", &running).await?.unwrap();
    assert_eq!(turn_state(&turn), "cancelling", "{turn}");
    let queued = view(&s).await?;
    assert_eq!(queued["queued_messages"][0]["text"], CORRECTION);
    assert_eq!(queued["queued_messages"][1]["text"], SECOND);
    s.agent.launch.remove_env("BUTLER_TEST_PAUSE_ADDR");
    s.crash_and_restart().await?;
    drop(cancelling);
    let next = stub.next().await;
    assert!(next.body.to_string().contains(CORRECTION));
    let queued = view(&s).await?;
    assert_eq!(queued["queued_messages"].as_array().unwrap().len(), 1);
    assert_eq!(queued["queued_messages"][0]["text"], SECOND);
    assert_eq!(queued["queued_messages"][0]["state"], "queued");
    next.answer();
    let id = turn_for(&s, CORRECTION).await?;
    terminal(&s, &id, "delivered").await?;
    stub.next().await.answer();
    let id = turn_for(&s, SECOND).await?;
    terminal(&s, &id, "delivered").await?;
    terminal(&s, &running, "cancelled").await?;
    assert_eq!(s.gw.turns("general").await?.len(), 3);
    let messages = s.gw.messages("general").await?;
    let texts: Vec<_> = messages
        .iter()
        .filter(|m| m["role"] == "user")
        .map(|m| m["text"].as_str().unwrap())
        .collect();
    assert_eq!(texts, [ORIGINAL, CORRECTION, SECOND]);
    assert_eq!(cancel_count(&s), 1);
    held.answer();
    s.finish().await
}

#[tokio::test]
async fn stop_after_send_now_pauses_cancelling_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut stub, setup) = Stub::setup().await?;
    let (mut barrier, address) = Barrier::start().await;
    let s = setup.env("BUTLER_TEST_PAUSE_ADDR", address).start().await?;
    stub.attach(&s)?;
    let running = s.gw.say_turn("general", ORIGINAL).await?;
    let held = stub.next().await;
    let correction = queue(&s, CORRECTION).await?;
    sent(&s, &correction).await?;
    let mut cancelling = barrier.held().await;
    let turn = s.gw.turn("general", &running).await?.unwrap();
    assert_eq!(turn_state(&turn), "cancelling", "{turn}");
    for _ in 0..2 {
        let stop =
            s.gw.post(&format!("/turns/{running}/cancel"), json!({}))
                .await?;
        assert_eq!(stop.status, 202, "{}", stop.text);
        let queued = s.gw.get("/session-queue?chat_id=general").await?;
        assert_eq!(queued.status, 200, "{}", queued.text);
        assert_eq!(queued.data()["paused"], true, "{}", queued.text);
        assert_eq!(queued.data()["queued_messages"][0]["id"], correction);
        assert_eq!(queued.data()["queued_messages"][0]["state"], "queued");
    }
    cancelling.write_all(b"1").await?;
    let turn =
        s.gw.wait_terminal("general", &running, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&turn), "cancelled", "{turn}");
    assert_eq!(s.gw.turns("general").await?.len(), 1);
    assert_eq!(
        s.gw.get("/session-queue?chat_id=general").await?.data()["paused"],
        true
    );
    assert_eq!(cancel_count(&s), 1);
    held.answer();
    s.finish().await
}

#[tokio::test]
async fn stop_persists_when_another_connection_writes_during_it() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut stub, setup) = Stub::setup().await?;
    let (mut barrier, address) = Barrier::start().await;
    let s = setup.env("BUTLER_TEST_PAUSE_ADDR", address).start().await?;
    stub.attach(&s)?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute(
        "CREATE TABLE concurrent_writes (value INTEGER NOT NULL)",
        [],
    )?;
    let running = s.gw.say_turn("general", ORIGINAL).await?;
    let held = stub.next().await;
    let stop =
        s.gw.post(&format!("/turns/{running}/cancel"), json!({}))
            .await?;
    assert_eq!(stop.status, 202, "{}", stop.text);
    let mut cancelling = barrier.held().await;
    db.execute_batch("BEGIN IMMEDIATE; INSERT INTO concurrent_writes VALUES (1)")?;
    cancelling.write_all(b"1").await?;
    // Let Stop reach storage while the other writer still owns the write lock.
    tokio::time::sleep(Duration::from_millis(300)).await;
    db.execute_batch("COMMIT")?;
    let terminal =
        s.gw.wait_terminal("general", &running, Duration::from_secs(30))
            .await;
    let native: String = db.query_row(
        "SELECT semantic_state FROM btcc_turns WHERE turn_id=?1",
        [&running],
        |r| r.get(0),
    )?;
    let stops: usize = db.query_row(
        "SELECT count(*) FROM btcc_stop_requests WHERE turn_id=?1",
        [&running],
        |r| r.get(0),
    )?;
    let turn = terminal?;
    assert_eq!(
        native, "cancelled",
        "native={native} stop_requests={stops} app={turn}"
    );
    assert_eq!(stops, 1, "native={native} stop_requests={stops} app={turn}");
    assert_eq!(turn_state(&turn), "cancelled", "{turn}");
    assert_eq!(cancel_count(&s), 1);
    held.answer();
    s.finish().await
}

#[tokio::test]
async fn stop_is_kept_when_its_storage_write_fails() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut stub, setup) = Stub::setup().await?;
    let (mut barrier, address) = Barrier::start().await;
    let s = setup.env("BUTLER_TEST_PAUSE_ADDR", address).start().await?;
    stub.attach(&s)?;
    let btcc_db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let app_db =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;

    let running = s.gw.say_turn("general", ORIGINAL).await?;
    let held = stub.next().await;
    let stop =
        s.gw.post(&format!("/turns/{running}/cancel"), json!({}))
            .await?;
    assert_eq!(stop.status, 202, "{}", stop.text);
    let mut cancelling = barrier.held().await;
    btcc_db.execute_batch(
        "CREATE TRIGGER e2e_stop_write_fault BEFORE INSERT ON btcc_stop_requests \
         BEGIN SELECT RAISE(ABORT, 'e2e stop write fault'); END",
    )?;
    cancelling.write_all(b"1").await?;

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let turn = s.gw.turn("general", &running).await?.unwrap();
        let app_state = turn_state(&turn);
        let outbox = outbox_state(&app_db, &running)?;
        let fault_lines = stop_fault_lines(&s.agent.logs(), &running);
        if !fault_lines.is_empty() || app_state == "cancelled" || outbox == "completed" {
            break;
        }
        assert!(Instant::now() < deadline, "Stop failure was not observed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let turn = s.gw.turn("general", &running).await?.unwrap();
    let app_state = turn_state(&turn).to_owned();
    let outbox = outbox_state(&app_db, &running)?;
    let native = native_state(&btcc_db, &running)?;
    let stop_requests = stop_request_count(&btcc_db, &running)?;
    let fault_lines = stop_fault_lines(&s.agent.logs(), &running);
    let diagnostic = stop_diagnostic(&app_state, &outbox, &native, stop_requests, &fault_lines);
    assert_eq!(fault_lines.len(), 1, "{diagnostic}");
    assert_ne!(app_state, "cancelled", "{diagnostic}");
    assert_ne!(outbox, "completed", "{diagnostic}");
    assert_eq!(stop_requests, 0, "{diagnostic}");

    btcc_db.execute_batch("DROP TRIGGER e2e_stop_write_fault")?;
    let mut redelivered = barrier.held().await;
    redelivered.write_all(b"1").await?;

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let turn = s.gw.turn("general", &running).await?.unwrap();
        if turn_state(&turn) == "cancelled" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "App turn never reached cancelled"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let turn = s.gw.turn("general", &running).await?.unwrap();
    let app_state = turn_state(&turn).to_owned();
    let outbox = outbox_state(&app_db, &running)?;
    let native = native_state(&btcc_db, &running)?;
    let stop_requests = stop_request_count(&btcc_db, &running)?;
    let fault_lines = stop_fault_lines(&s.agent.logs(), &running);
    let diagnostic = stop_diagnostic(&app_state, &outbox, &native, stop_requests, &fault_lines);
    assert_eq!(app_state, "cancelled", "{diagnostic}");
    assert_eq!(native, "cancelled", "{diagnostic}");
    assert_eq!(stop_requests, 1, "{diagnostic}");
    assert_eq!(outbox, "completed", "{diagnostic}");
    assert_eq!(cancel_count(&s), 1, "{diagnostic}");
    assert_eq!(fault_lines.len(), 1, "{diagnostic}");

    held.answer();
    s.finish().await
}
