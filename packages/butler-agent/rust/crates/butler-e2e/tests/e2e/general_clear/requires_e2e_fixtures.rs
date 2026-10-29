//! App cancellation does not make a committed BTCC delivery safe to archive.
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::{Fixture, Setup};
use butler_e2e::e2e::{HarnessError, fixtures};
use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::mpsc,
};

struct DeliveryBarrier {
    events: mpsc::UnboundedReceiver<TcpStream>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for DeliveryBarrier {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl DeliveryBarrier {
    async fn start() -> Result<(Self, String), HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?.to_string();
        let (send, events) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let send = send.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stream);
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    if line.starts_with("delivery_inserted\t") {
                        send.send(reader.into_inner()).unwrap();
                    } else {
                        reader.into_inner().write_all(b"1").await.unwrap();
                    }
                });
            }
        });
        Ok((Self { events, server }, address))
    }

    async fn held(&mut self) -> TcpStream {
        tokio::time::timeout(Duration::from_secs(30), self.events.recv())
            .await
            .unwrap()
            .unwrap()
    }
}

#[tokio::test]
async fn clear_refuses_committed_delivery_after_app_cancellation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut barrier, address) = DeliveryBarrier::start().await?;
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let setup = Setup::new("GENERAL-CLEAR-FINALIZING")?
        .fixture(Fixture::Empty)
        .env("BUTLER_TEST_PAUSE_ADDR", address)
        .env("BUTLER_OLLAMA_BASE_URL", server.base_url.clone());
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, fixtures::FIXTURE_TIME)?;
    let s = setup.start().await?;
    let model =
        s.gw.post(
            "/model-catalog/local-models",
            json!({
                "provider_id":"local", "api_type":"openai_compatible", "platform":"ollama",
                "server_url":server.base_url, "model_id":LOCAL_MODEL, "display_name":LOCAL_MODEL,
                "context_window_tokens":131_072, "source":"discovered"
            }),
        )
        .await?;
    assert_eq!(model.status, 201, "{}", model.text);
    let settings =
        s.gw.patch(
            "/settings",
            json!({"model":model.data()["model"]["model_ref"]}),
        )
        .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    let turn = s.gw.say_turn("general", "Hello there.").await?;
    let mut held = barrier.held().await;
    let cancel =
        s.gw.post(&format!("/turns/{turn}/cancel"), json!({}))
            .await?;
    assert_eq!(cancel.status, 202, "{}", cancel.text);
    let terminal =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&terminal), "cancelled", "{terminal}");
    let queue = s.gw.get("/session-queue?chat_id=general").await?;
    assert!(
        queue.data()["queued_messages"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{queue:?}"
    );
    let clear =
        s.gw.post("/sessions/general/clear", json!({"title":"Finalizing"}))
            .await?;
    assert_eq!(clear.status, 409, "{}", clear.text);
    assert_eq!(clear.error_code(), Some("session_busy"));
    // Stop preserves the committed answer. Release its old permit and re-entry.
    held.write_all(b"1").await?;
    barrier.held().await.write_all(b"1").await?;
    s.finish().await
}
