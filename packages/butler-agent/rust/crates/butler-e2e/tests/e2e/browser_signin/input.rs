use super::host::{admin, attach, snapshot, tab};
use super::tool::waiting_card;
use butler_e2e::e2e::{
    HarnessError,
    gateway::{Gateway, turn_state},
    scenario::Setup,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

const ORIGIN: &str = "https://login.fixture-shop.test";
const LOGIN: &str = "https://login.fixture-shop.test/";
const CANARY_USER: &str = "canary-user-handoff-87e@fixture.test";
const CANARY_PASS: &str = "canary-pass-handoff-1a4";

#[tokio::test]
async fn typed_input_reaches_only_the_page_and_save_goes_to_main() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let ask = "Help me sign in";
    let s = Setup::new("BROWSER-INPUT-HANDOFF")?
        .stub_cassette(super::wait::cassette(ask, "sign_in")?)
        .data_folder_token()
        .start()
        .await?;
    let admin = admin(&s);
    let pulls = Arc::new(Mutex::new(Vec::new()));
    let host = attach(&s, Arc::new({
        let admin = admin.clone();
        let pulls = pulls.clone();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        move |frame: Value| {
            let (admin, pulls, reads) = (admin.clone(), pulls.clone(), reads.clone());
            Box::pin(async move {
                match frame["op"].as_str() {
                    Some("tab.wait") => json!({"status":"user_control","tab":"t1","epoch":1}),
                    Some("input.fields") => {
                        let fields = if reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
                            json!(["username","password"])
                        } else { json!([]) };
                        json!({"status":"ok","origin":ORIGIN,"fields":fields,"live":false,"save_offer":null})
                    }
                    Some("input.fill") => {
                        let token = frame["args"]["token"].as_str().unwrap();
                        let path = format!("/internal/browser-host/inputs/{token}");
                        let first = pulls.lock().unwrap().is_empty();
                        let origins = if first { &[ORIGIN, ORIGIN][..] } else { &["https://www.fixture-shop.test"][..] };
                        for origin in origins {
                            let reply = admin.send(Method::POST, &path, Some(json!({"origin":origin})), &[]).await.unwrap();
                            pulls.lock().unwrap().push((reply.status, reply.body));
                        }
                        json!({"status":"filled","navigated":true,"origin":ORIGIN,"fields":[],"live":false,
                            "save_offer":{"username":"u@fixture.test","host":"login.fixture-shop.test"}})
                    }
                    Some("signin.save_offer") => json!({"ok":true}),
                    _ => json!({"status":"ok","tab":"t1","url":LOGIN}),
                }
            })
        }
    })).await?;
    snapshot(
        &admin,
        json!([tab("t1", "conversation:general", LOGIN, "user")]),
    )
    .await?;

    let turn = s.gw.say_turn("general", ask).await?;
    let card = waiting_card(&s, &turn).await?;
    let reference = card["request_ref"].as_str().unwrap();
    let input = format!("/authority-requests/{reference}/input?session_id=general");
    let fields = admin.send(Method::GET, &input, None, &[]).await?;
    assert_eq!(fields.status, 200);
    assert_eq!(fields.data()["fields"], json!(["username", "password"]));
    assert_eq!(fields.data()["origin"], ORIGIN);

    let values = json!({"origin":ORIGIN,"values":{"username":CANARY_USER,"password":CANARY_PASS}});
    let submitted = admin
        .send(Method::POST, &input, Some(values.clone()), &[])
        .await?;
    assert_eq!(submitted.status, 200);
    assert_eq!(submitted.data()["status"], "filled");
    assert_eq!(submitted.data()["handed_back"], false);
    admin
        .send(Method::POST, &input, Some(values.clone()), &[])
        .await?;
    {
        let pulls = pulls.lock().unwrap();
        assert_eq!(
            pulls.iter().map(|(status, _)| *status).collect::<Vec<_>>(),
            [200, 410, 403]
        );
        assert!(
            pulls[0].1["username"] == CANARY_USER && pulls[0].1["password"] == CANARY_PASS,
            "the page pulled both submitted values"
        );
    }

    let pin = crate::gateway_pairing::support::helpers::issue(&admin).await?;
    let (paired, answer) = tokio::join!(
        s.gw.post("/devices/pair", json!({"code":pin["code"],"device_name":"Test phone","platform":"ios","public_key":"later","match_code":"47"})),
        admin.answer_pairing(Some("47")),
    );
    answer?;
    let paired = paired?;
    assert_eq!(paired.status, 201);
    let phone = Gateway::new(
        s.gw.base.clone(),
        paired.data()["device_token"].as_str().unwrap().to_owned(),
    );
    let refused = phone.post(&input, values).await?;
    assert_eq!(refused.status, 403);
    assert_eq!(refused.error_code(), Some("secure_channel_required"));

    let save = format!("/authority-requests/{reference}/input-save?session_id=general");
    let saved = admin
        .send(Method::POST, &save, Some(json!({"save":true})), &[])
        .await?;
    assert_eq!(saved.status, 200);
    assert_eq!(saved.data()["saved"], true);
    assert_eq!(saved.data()["handed_back"], true);
    assert_eq!(
        host.last("signin.save_offer").unwrap()["args"],
        json!({"save":true})
    );
    snapshot(
        &admin,
        json!([tab("t1", "conversation:general", LOGIN, "agent")]),
    )
    .await?;
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered");

    let requests = s.provider()?.requests();
    let logs = s.agent.logs();
    let paths = [
        "/events?limit=500",
        "/authority-requests?session_id=general",
        "/session-view?session_id=general",
    ];
    for path in paths {
        let response = s.gw.get(path).await?;
        assert_eq!(response.status, 200);
        for canary in [CANARY_USER, CANARY_PASS] {
            assert!(!response.text.contains(canary), "canary in {path}");
        }
    }
    for canary in [CANARY_USER, CANARY_PASS] {
        assert!(
            requests
                .iter()
                .all(|request| !request.to_string().contains(canary)),
            "canary in model request"
        );
        assert!(
            host.frames
                .lock()
                .unwrap()
                .iter()
                .all(|frame| !frame.to_string().contains(canary)),
            "canary in host frame"
        );
        super::canary_absent(&s.sandbox.data, canary, &logs);
        super::canary_absent(&s.sandbox.home, canary, &logs);
    }
    s.finish().await
}
