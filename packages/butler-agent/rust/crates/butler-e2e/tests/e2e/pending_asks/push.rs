use super::{
    chat,
    stub::{ASK, start},
};
use crate::gateway_pairing::support::helpers::{admin, assert_no_secrets, browser, issue};
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    fixtures::default_project_folder,
    gateway::turn_state,
    scenario::{Access, Setup},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Default)]
struct Expo {
    bodies: Mutex<Vec<Value>>,
    unregistered: Mutex<String>,
}

async fn tickets(State(expo): State<Arc<Expo>>, Json(body): Json<Value>) -> Json<Value> {
    let mut bodies = expo.bodies.lock().unwrap();
    bodies.push(body.clone());
    let unregistered = expo.unregistered.lock().unwrap();
    let data: Vec<_> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|msg| {
            if msg["to"] == unregistered.as_str() {
                json!({"status":"error","message":"x","details":{"error":"DeviceNotRegistered"}})
            } else {
                json!({"status":"ok","id":"t"})
            }
        })
        .collect();
    Json(json!({"data":data}))
}

async fn wait_requests(expo: &Expo, n: usize) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(15), async {
        while expo.bodies.lock().unwrap().len() < n {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| HarnessError(format!("Expo did not receive {n} requests")))
}

#[tokio::test]
async fn push_01_phone_gets_status_only_pushes_until_unregistered_or_revoked()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, _, stub_server) = start().await?;
    let expo = Arc::new(Expo::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let router = Router::new()
        .route("/push/send", post(tickets))
        .with_state(expo.clone());
    let expo_server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let s = Setup::new("PUSH-01")?
        .data_folder_token()
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .env("BUTLER_PUSH_URL", format!("http://{addr}/push/send"))
        .start()
        .await?;
    default_project_folder(&s).await?;
    let app = admin(&s);
    let client = browser();
    let mut devices = Vec::new();
    for name in ["Phone A", "Phone B", "Phone C"] {
        let pin = issue(&app).await?;
        let reply = client
            .post(format!("{}/devices/pair", s.gw.base))
            .json(&json!({"code":pin["code"],"device_name":name,"platform":"ios"}))
            .send()
            .await?;
        assert_eq!(reply.status(), 201);
        let body: Value = reply.json().await?;
        devices.push(body["data"]["device_token"].as_str().unwrap().to_owned());
    }
    let push_url = format!("{}/devices/self/push", s.gw.base);
    let reply = client
        .put(&push_url)
        .bearer_auth(&devices[0])
        .json(&json!({"token":"not-expo"}))
        .send()
        .await?;
    assert_eq!(reply.status(), 400);
    let [a, b, c] = [
        "ExponentPushToken[a]",
        "ExponentPushToken[b]",
        "ExponentPushToken[c]",
    ];
    let reply = client
        .put(&push_url)
        .bearer_auth(&s.gw.token)
        .json(&json!({"token":a}))
        .send()
        .await?;
    assert_eq!(reply.status(), 403);
    assert_eq!(
        reply.json::<Value>().await?["error"]["code"],
        "device_token_required"
    );
    for (device, token) in devices.iter().zip([a, b, c]) {
        let reply = client
            .put(&push_url)
            .bearer_auth(device)
            .json(&json!({"token":token}))
            .send()
            .await?;
        assert_eq!(reply.status(), 204);
    }
    *expo.unregistered.lock().unwrap() = a.into();

    let chat1 = chat(&s, "Quarterly secret plan").await?;
    let (_, turn) = s.turn(&chat1, ASK).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    wait_requests(&expo, 2).await?;
    {
        let bodies = expo.bodies.lock().unwrap();
        let mut kinds = BTreeSet::new();
        for (body, expected_tokens) in bodies
            .iter()
            .zip([BTreeSet::from([a, b, c]), BTreeSet::from([b, c])])
        {
            let mut tokens = BTreeSet::new();
            for message in body.as_array().unwrap() {
                let token = message["to"].as_str().unwrap();
                let kind = message["data"]["kind"].as_str().unwrap();
                let text = match kind {
                    "done" => "Done",
                    "needs_input" => "Needs your input",
                    _ => panic!("unexpected push kind"),
                };
                assert_eq!(
                    *message,
                    json!({
                        "to":token,"title":"Butler","body":text,"sound":"default",
                        "data":{"kind":kind,"session_id":chat1}
                    })
                );
                kinds.insert(kind);
                tokens.insert(token);
            }
            assert_eq!(tokens, expected_tokens);
            let serialized = body.to_string();
            for secret in [
                "Quarterly secret plan",
                ASK,
                "Saved. The reply is complete.",
            ] {
                assert!(!serialized.contains(secret), "chat content in push");
            }
        }
        assert_eq!(kinds, BTreeSet::from(["done", "needs_input"]));
    }

    let reply = client
        .delete(format!("{}/devices/self", s.gw.base))
        .bearer_auth(&devices[1])
        .send()
        .await?;
    assert_eq!(reply.status(), 204);
    let chat2 = chat(&s, "Second").await?;
    let (_, turn) = s.turn(&chat2, "Write one short line.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    wait_requests(&expo, 3).await?;
    {
        let bodies = expo.bodies.lock().unwrap();
        let messages = bodies[2].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["to"], c);
        assert_eq!(messages[0]["data"]["session_id"], chat2);
        assert_eq!(bodies.len(), 3);
    }
    assert_no_secrets(&s, &devices.iter().map(String::as_str).collect::<Vec<_>>())?;
    expo_server.abort();
    stub_server.abort();
    s.finish().await
}
