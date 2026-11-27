use super::{
    chat,
    stub::{ASK, start},
};
use crate::gateway_pairing::support::helpers::{admin, assert_no_secrets, browser, issue};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    fake_butler_cloud::FakeButlerCloud,
    fixtures::default_project_folder,
    gateway::turn_state,
    scenario::{Access, Setup},
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{collections::BTreeSet, time::Duration};

#[tokio::test]
async fn push_01_phone_gets_status_only_pushes_via_relay_until_gone_or_revoked()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeButlerCloud::start().await?;
    let (url, _, stub_server) = start().await?;
    let setup = Setup::new("PUSH-01")?
        .data_folder_token()
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .env("BUTLER_CLOUD_API_URL", &fake.url);
    std::fs::create_dir_all(setup.sandbox.data.join("gateways"))?;
    std::fs::write(
        setup.sandbox.data.join("gateways/app.json"),
        json!({"config": {"butlerAccountEnabled": true}}).to_string(),
    )?;
    let s = setup.start().await?;
    default_project_folder(&s).await?;
    s.patch_settings(json!({"language":"ko"}), "UI language")
        .await?;
    let app = admin(&s);
    let client = browser();
    let mut devices = Vec::new();
    for name in ["Phone A", "Phone B", "Phone C"] {
        let pin = issue(&app).await?;
        let pair = client
            .post(format!("{}/devices/pair", s.gw.base))
            .json(
                &json!({"code":pin["code"],"device_name":name,"platform":"ios","match_code":"47"}),
            )
            .send();
        let (reply, answer) = tokio::join!(pair, app.answer_pairing(true));
        answer?;
        let reply = reply?;
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
    let reply = client
        .get(&push_url)
        .bearer_auth(&devices[0])
        .send()
        .await?;
    assert_eq!(reply.status(), 200);
    assert_eq!(reply.json::<Value>().await?["data"]["available"], false);
    for (device, token) in devices.iter().zip([a, b, c]) {
        let reply = client
            .put(&push_url)
            .bearer_auth(device)
            .json(&if token == b {
                json!({"token":token,"lang":"en","kinds":["needs_input","failed","schedule_blocked","later_kind"]})
            } else {
                json!({"token":token})
            })
            .send()
            .await?;
        assert_eq!(reply.status(), 204);
    }

    let reply = app
        .send(
            Method::POST,
            "/setup/butler-account",
            Some(json!({"action": "verify", "email": "user@example.com", "code": "123456"})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data()["signed_in"], true);
    let reply = client
        .get(&push_url)
        .bearer_auth(&devices[0])
        .send()
        .await?;
    assert_eq!(reply.status(), 200);
    assert_eq!(reply.json::<Value>().await?["data"]["available"], true);
    fake.set_push_gone(a);

    let chat1 = chat(&s, "Quarterly secret plan").await?;
    let (_, turn) = s.turn(&chat1, ASK).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let bodies = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let bodies = fake.push_sends();
            let kinds: BTreeSet<_> = bodies
                .iter()
                .flat_map(|body| body["messages"].as_array().unwrap())
                .filter(|message| message["session_id"] == chat1)
                .filter_map(|message| message["kind"].as_str())
                .collect();
            if kinds.contains("needs_input") && kinds.contains("done") {
                break bodies;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| HarnessError("Relay did not receive both push kinds".into()))?;
    let first_kind = bodies[0]["messages"][0]["kind"].as_str().unwrap();
    let mut first_tokens = BTreeSet::new();
    let mut second_tokens = BTreeSet::new();
    for body in &bodies {
        assert!(
            body.as_object()
                .is_some_and(|entry| entry.len() == 1 && entry.contains_key("messages"))
        );
        for message in body["messages"].as_array().unwrap() {
            let token = message["to"].as_str().unwrap();
            let kind = message["kind"].as_str().unwrap();
            assert!(matches!(kind, "needs_input" | "done"));
            let lang = if token == b { "en" } else { "ko" };
            assert!(
                *message == json!({"to":token,"kind":kind,"lang":lang,"session_id":chat1}),
                "unexpected push message"
            );
            if kind == first_kind {
                first_tokens.insert(token);
            } else {
                second_tokens.insert(token);
            }
        }
        let serialized = body.to_string();
        for secret in [
            "Quarterly secret plan",
            ASK,
            "Saved. The reply is complete.",
        ] {
            assert!(!serialized.contains(secret), "chat content in push");
        }
    }
    let second_kind = if first_kind == "done" {
        "needs_input"
    } else {
        "done"
    };
    let expected = |kind: &str, tokens: &[&'static str]| -> BTreeSet<&'static str> {
        tokens
            .iter()
            .copied()
            .filter(|token| kind != "done" || *token != b)
            .collect()
    };
    assert!(
        first_tokens == expected(first_kind, &[a, b, c]),
        "unexpected first push recipients"
    );
    assert!(
        second_tokens == expected(second_kind, &[b, c]),
        "unexpected second push recipients"
    );
    assert!(
        fake.seen()
            .iter()
            .any(|entry| entry == "PUT /v1/push/tokens")
    );

    let reply = client
        .delete(format!("{}/devices/self", s.gw.base))
        .bearer_auth(&devices[1])
        .send()
        .await?;
    assert_eq!(reply.status(), 204);
    let chat2 = chat(&s, "Second").await?;
    let (_, turn) = s.turn(&chat2, "Write one short line.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let bodies = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let bodies = fake.push_sends();
            if bodies
                .iter()
                .flat_map(|body| body["messages"].as_array().unwrap())
                .any(|message| message["session_id"] == chat2 && message["kind"] == "done")
            {
                break bodies;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| HarnessError("Relay did not receive the second turn push".into()))?;
    let tokens: BTreeSet<_> = bodies
        .iter()
        .flat_map(|body| body["messages"].as_array().unwrap())
        .filter(|message| message["session_id"] == chat2)
        .map(|message| message["to"].as_str().unwrap())
        .collect();
    assert!(
        tokens == BTreeSet::from([c]),
        "unexpected recipients after revoke"
    );
    assert_no_secrets(&s, &devices.iter().map(String::as_str).collect::<Vec<_>>())?;
    stub_server.abort();
    s.finish().await
}
