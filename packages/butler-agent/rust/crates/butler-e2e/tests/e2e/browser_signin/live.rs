use super::host::{admin, attach, snapshot, tab};
use super::{tool::waiting_card, wait::cassette};
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{HarnessError, events::LiveEvents, gateway::turn_state, scenario::Setup};
use bytes::{Buf, Bytes, BytesMut};
use reqwest::{Client, Method, Response};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::time::{Instant, sleep, timeout, timeout_at};

const PAGE: &str = "https://www.fixture-shop.test/checkout";
const ASK: &str = "Help me enter the card number";
const LIVE: &str = "/browser/tabs/t1/live";
const WAIT: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Records(BytesMut);

impl Records {
    async fn next(&mut self, stream: &mut Response) -> Result<Option<(u8, Bytes)>, HarnessError> {
        loop {
            if self.0.len() >= 5 {
                let len = u32::from_be_bytes(self.0[1..5].try_into().unwrap()) as usize;
                if self.0.len() >= 5 + len {
                    let kind = self.0[0];
                    self.0.advance(5);
                    return Ok(Some((kind, self.0.split_to(len).freeze())));
                }
            }
            let Some(chunk) = stream.chunk().await? else {
                assert!(self.0.is_empty(), "truncated live record");
                return Ok(None);
            };
            self.0.extend_from_slice(&chunk);
        }
    }
}

#[tokio::test]
async fn live_stream_needs_open_hand_off_and_ends_on_hand_back() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-LIVE-HAND-BACK")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    let admin = admin(&s);
    let host = attach(
        &s,
        Arc::new(|frame| {
            Box::pin(async move {
                if frame["op"] == "tab.wait" {
                    return json!({"status":"user_control","tab":frame["tab"],"epoch":1});
                }
                json!({"status":"ok"})
            })
        }),
    )
    .await?;
    snapshot(
        &admin,
        json!([tab("t1", "conversation:general", PAGE, "user")]),
    )
    .await?;

    let client = Client::new();
    let get = || {
        client
            .get(format!("{}{LIVE}?width=4000", s.gw.base))
            .bearer_auth(&s.gw.token)
    };
    let refused = get().send().await?;
    assert_eq!(refused.status(), 409);
    assert_eq!(
        refused.json::<Value>().await?["error"]["code"],
        "no_hand_off"
    );

    let turn = s.gw.say_turn("general", ASK).await?;
    waiting_card(&s, &turn).await?;
    let mut stream = get().send().await?;
    assert_eq!(stream.status(), 200);
    let start = host.last("live.start").unwrap();
    assert_eq!(start["args"]["width"], 1280);
    let sub = start["args"]["sub"].as_str().unwrap();
    let jpeg = [0xff, 0xd8, b'A'];
    let upload = admin
        .send(
            Method::POST,
            &format!("/internal/browser-host/live/{sub}"),
            Some(json!({"width":1280,"height":800,"jpeg":STANDARD.encode(jpeg)})),
            &[],
        )
        .await?;
    assert_eq!(upload.status, 200, "{}", upload.text);

    let mut records = Records::default();
    let (kind, meta) = timeout(WAIT, records.next(&mut stream))
        .await
        .unwrap()?
        .unwrap();
    assert_eq!(kind, 1);
    assert_eq!(
        serde_json::from_slice::<Value>(&meta).unwrap(),
        json!({"width":1280,"height":800})
    );
    let (kind, frame) = timeout(WAIT, records.next(&mut stream))
        .await
        .unwrap()?
        .unwrap();
    assert_eq!(kind, 2);
    assert_eq!(frame.as_ref(), jpeg);

    snapshot(
        &admin,
        json!([tab("t1", "conversation:general", PAGE, "agent")]),
    )
    .await?;
    let (kind, end) = timeout(WAIT, records.next(&mut stream))
        .await
        .unwrap()?
        .unwrap();
    assert_eq!(kind, 4);
    assert_eq!(
        serde_json::from_slice::<Value>(&end).unwrap(),
        json!({"reason":"handed_back"})
    );
    assert!(
        timeout(WAIT, records.next(&mut stream))
            .await
            .unwrap()?
            .is_none()
    );
    timeout(WAIT, async {
        while host.last("live.stop").is_none() {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(host.last("live.stop").unwrap()["args"]["sub"], sub);
    assert_eq!(host.ops().iter().filter(|op| *op == "live.stop").count(), 1);
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    s.finish().await
}

#[tokio::test]
async fn last_viewer_drop_stops_capture() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-LIVE-VIEWERS")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    let admin = admin(&s);
    let host = attach(
        &s,
        Arc::new(|frame| {
            Box::pin(async move {
                if frame["op"] == "tab.wait" {
                    return json!({"status":"user_control","tab":frame["tab"],"epoch":1});
                }
                json!({"status":"ok"})
            })
        }),
    )
    .await?;
    snapshot(
        &admin,
        json!([tab("t1", "conversation:general", PAGE, "user")]),
    )
    .await?;
    let turn = s.gw.say_turn("general", ASK).await?;
    waiting_card(&s, &turn).await?;

    let client = Client::new();
    let get = || {
        client
            .get(format!("{}{LIVE}", s.gw.base))
            .bearer_auth(&s.gw.token)
            .send()
    };
    let (first, second) = tokio::try_join!(get(), get())?;
    assert_eq!(first.status(), 200);
    assert_eq!(second.status(), 200);
    assert_eq!(
        host.ops().iter().filter(|op| *op == "live.start").count(),
        1
    );
    let start = host.last("live.start").unwrap();
    let sub = start["args"]["sub"].as_str().unwrap();

    drop(first);
    sleep(Duration::from_millis(100)).await;
    assert!(host.last("live.stop").is_none());
    drop(second);
    timeout(WAIT, async {
        while host.last("live.stop").is_none() {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(host.ops().iter().filter(|op| *op == "live.stop").count(), 1);
    assert_eq!(host.last("live.stop").unwrap()["args"]["sub"], sub);
    let upload = admin
        .send(
            Method::POST,
            &format!("/internal/browser-host/live/{sub}"),
            Some(json!({"width":720,"height":480,"jpeg":STANDARD.encode([0xff, 0xd8])})),
            &[],
        )
        .await?;
    assert_eq!(upload.status, 404, "{}", upload.text);
    assert_eq!(upload.body["error"]["code"], "live_ended");

    let third = get().await?;
    assert_eq!(third.status(), 200);
    assert_ne!(host.last("live.start").unwrap()["args"]["sub"], sub);
    drop(third);
    s.finish().await
}

#[tokio::test]
async fn slow_viewer_gets_latest_frame() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-LIVE-LATEST")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    let admin = admin(&s);
    let host = attach(
        &s,
        Arc::new(|frame| {
            Box::pin(async move {
                if frame["op"] == "tab.wait" {
                    return json!({"status":"user_control","tab":frame["tab"],"epoch":1});
                }
                json!({"status":"ok"})
            })
        }),
    )
    .await?;
    snapshot(
        &admin,
        json!([tab("t1", "conversation:general", PAGE, "user")]),
    )
    .await?;
    let turn = s.gw.say_turn("general", ASK).await?;
    waiting_card(&s, &turn).await?;

    let mut stream = Client::new()
        .get(format!("{}{LIVE}", s.gw.base))
        .bearer_auth(&s.gw.token)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    let start = host.last("live.start").unwrap();
    let sub = start["args"]["sub"].as_str().unwrap();
    let upload_path = format!("/internal/browser-host/live/{sub}");
    let mut records = Records::default();
    for index in 1..=10 {
        let upload = admin
            .send(
                Method::POST,
                &upload_path,
                Some(json!({"width":720,"height":480,"jpeg":STANDARD.encode([0xff, 0xd8, index])})),
                &[],
            )
            .await?;
        assert_eq!(upload.status, 200, "{}", upload.text);
        if index == 1 {
            assert_eq!(
                timeout(WAIT, records.next(&mut stream))
                    .await
                    .unwrap()?
                    .unwrap()
                    .0,
                1
            );
            let (kind, frame) = timeout(WAIT, records.next(&mut stream))
                .await
                .unwrap()?
                .unwrap();
            assert_eq!(kind, 2);
            assert_eq!(frame.as_ref(), [0xff, 0xd8, 1]);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut received = 0;
    let mut last = Bytes::new();
    while let Ok(record) = timeout_at(deadline, records.next(&mut stream)).await {
        let (kind, frame) = record?.expect("live stream ended");
        assert_eq!(kind, 2);
        received += 1;
        last = frame;
    }
    assert_eq!(last.as_ref(), [0xff, 0xd8, 10]);
    assert!(received < 9, "received {received} frames after the first");
    drop(stream);
    s.finish().await
}

#[tokio::test]
async fn input_forwarded_only_while_user_held_and_never_model_visible() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-LIVE-INPUT")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    let admin = admin(&s);
    let host = attach(
        &s,
        Arc::new(|frame| {
            Box::pin(async move {
                if frame["op"] == "tab.wait" {
                    return json!({"status":"user_control","tab":frame["tab"],"epoch":1});
                }
                json!({"status":"ok"})
            })
        }),
    )
    .await?;
    snapshot(
        &admin,
        json!([tab("t1", "conversation:general", PAGE, "user")]),
    )
    .await?;
    let turn = s.gw.say_turn("general", ASK).await?;
    waiting_card(&s, &turn).await?;

    let client = Client::new();
    let post = |batch: &Value| {
        client
            .post(format!("{}{LIVE}/input", s.gw.base))
            .bearer_auth(&s.gw.token)
            .json(batch)
            .send()
    };
    let sentinel = "SENTINEL-4721";
    let id = uuid::Uuid::new_v4().to_string();
    let events = json!([{"t":"text","value":sentinel}]);
    let batch = json!({"client":id,"seq":1,"events":events});
    let refused = post(&batch).await?;
    assert_eq!(refused.status(), 409);
    assert_eq!(
        refused.json::<Value>().await?["error"]["code"],
        "live_not_open"
    );

    let stream = client
        .get(format!("{}{LIVE}", s.gw.base))
        .bearer_auth(&s.gw.token)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    let applied = post(&batch).await?;
    assert_eq!(applied.status(), 200);
    assert_eq!(
        applied.json::<Value>().await?["data"],
        json!({"seq":1,"applied":true})
    );
    assert_eq!(host.last("live.input").unwrap()["args"]["events"], events);

    for invalid in [
        json!({"t":"down","x":1.5,"y":0}),
        json!({"t":"key","key":"Unknown"}),
    ] {
        let rejected = post(&json!({"client":id,"seq":2,"events":[invalid]})).await?;
        assert_eq!(rejected.status(), 400);
        assert_eq!(
            rejected.json::<Value>().await?["error"]["code"],
            "invalid_input"
        );
    }
    let rejected = post(&json!({"client":id,"seq":2,"events":[]})).await?;
    assert_eq!(rejected.status(), 400);
    let duplicate = post(&batch).await?;
    assert_eq!(duplicate.status(), 200);
    assert_eq!(
        host.ops().iter().filter(|op| *op == "live.input").count(),
        1
    );

    snapshot(
        &admin,
        json!([tab("t1", "conversation:general", PAGE, "agent")]),
    )
    .await?;
    let refused = post(&batch).await?;
    assert_eq!(refused.status(), 409);
    assert_eq!(
        refused.json::<Value>().await?["error"]["code"],
        "live_not_held"
    );
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    let replay = LiveEvents::subscribe(&s.gw, 0).await?;
    replay
        .wait_turn(&s.gw, "general", &turn, &["delivered"], WAIT)
        .await?;
    assert!(!json!(replay.snapshot()).to_string().contains(sentinel));
    assert!(
        !json!(s.gw.messages("general").await?)
            .to_string()
            .contains(sentinel)
    );
    assert!(
        !s.provider()?
            .requests()
            .iter()
            .any(|request| request.to_string().contains(sentinel))
    );

    drop(stream);
    s.finish().await
}
