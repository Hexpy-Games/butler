//! Holds native cancellation after the App has persisted its durable outbox.
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

#[tokio::test]
async fn restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut stub, setup) = Stub::setup().await?;
    let (mut barrier, address) = Barrier::start().await;
    let mut s = setup.env("BUTLER_TEST_PAUSE_ADDR", address).start().await?;
    stub.attach(&s)?;
    let running = accepted_turn_id(&s.gw.say("general", ORIGINAL).await?)?;
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
