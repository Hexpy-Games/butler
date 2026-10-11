//! Card and traveler fills with the system keychain: a top-level origin that
//! is not the tab's is refused before any token, a frame outside the binding
//! burns the token without values, the right origins get the values exactly
//! once, and nothing but masked metadata leaves the vault.
use super::super::fill::keychain_opt_in;
use super::{CANARY, CARD, CHECKOUT, Cleanup, admin, attach, call, snapshot, tab, vault_scenario};
use butler_e2e::e2e::HarnessError;
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const RRN: &str = "9001011234567";
const TOP: &str = "https://www.fixture-shop.test";
const PAY: &str = "https://js.tosspayments.com";

#[tokio::test]
async fn vault_fill_is_bound_to_exact_origins_single_use_and_masked() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        keychain_opt_in(),
        "system keychain check needs BUTLER_PLATFORM_SYSTEM_SECRETS=1"
    );
    let s = vault_scenario("BROWSER-VAULT-FILL", None).await?;
    let admin = admin(&s);
    let mut cleanup = Cleanup::new(&admin);
    let bad = json!({"number": "4000 0566 5566 5557", "exp_month": 12, "exp_year": 2030});
    assert_eq!(
        admin
            .send(Method::POST, "/security/vault/cards", Some(bad), &[])
            .await?
            .status,
        400,
        "Luhn"
    );
    let card = json!({"nickname": "Travel card", "number": CARD, "exp_month": 12, "exp_year": 30, "cvc": "737",
        "holder_name": "HONG GILDONG", "pin2": "12", "owner_id": "900101"});
    let added = admin
        .send(Method::POST, "/security/vault/cards", Some(card), &[])
        .await?;
    assert_eq!(added.status, 200, "{}", added.text);
    let card_id = added.data()["id"].as_str().unwrap().to_owned();
    cleanup.track("cards", &card_id);
    let view = admin
        .send(Method::GET, "/security/vault", None, &[])
        .await?;
    let listed = &view.data()["cards"][0];
    assert_eq!(
        (listed["last4"].as_str(), listed["brand"].as_str()),
        (Some("5556"), Some("visa")),
        "{listed}"
    );
    assert_eq!(listed["exp_year"], 2030);
    assert_eq!(listed["extras"], json!(["pin2", "owner_id"]));
    assert!(
        !view.text.contains(CANARY) && !view.text.contains("737"),
        "metadata only"
    );
    // Reveal needs the OS to verify the user; the harness denies every prompt.
    let reveal = admin
        .send(
            Method::POST,
            &format!("/security/vault/cards/{card_id}/reveal"),
            Some(json!({})),
            &[],
        )
        .await?;
    assert_eq!(reveal.status, 403, "{}", reveal.text);
    assert!(!reveal.text.contains(CANARY));
    let traveler = json!({"nickname": "Me", "name": "홍길동", "gender": "M", "nationality": "KR",
        "birth_date": "1990-01-01", "passport_number": "M12345678", "rrn": "900101-1234567"});
    let saved = admin
        .send(
            Method::POST,
            "/security/vault/travelers",
            Some(traveler),
            &[],
        )
        .await?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    let traveler_id = saved.data()["id"].as_str().unwrap().to_owned();
    cleanup.track("travelers", &traveler_id);

    let pulls = Arc::new(Mutex::new(Vec::<(u16, String)>::new()));
    let script = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let host = attach(&s, responder(admin.clone(), pulls.clone(), script.clone())).await?;
    snapshot(&admin, json!([tab("t1", "agent", CHECKOUT)])).await?;
    let looked = call(&admin, "general", "pay.lookup", "t1", json!({})).await?;
    assert_eq!(looked["site"], "fixture-shop.test", "{looked}");
    assert_eq!(looked["cards"][0]["last4"], "5556");
    assert_eq!(looked["cards"][0]["allowed"], false);
    assert!(!looked.to_string().contains(CANARY) && !looked.to_string().contains(RRN));
    let fill = |top: &str| json!({"item_id": card_id, "top_origin": top, "frame_origins": [PAY]});

    // A top-level origin other than the tab's is refused before any token.
    let refused = call(
        &admin,
        "general",
        "pay.fill",
        "t1",
        fill("https://files.fixture-shop.test"),
    )
    .await?;
    assert_eq!(refused["status"], "origin_mismatch", "{refused}");
    assert!(
        !host.ops().contains(&"pay.fill".to_owned()),
        "no token was minted"
    );
    // A frame outside the binding burns the token without the values.
    script.lock().unwrap().push("look-alike");
    let result = call(&admin, "general", "pay.fill", "t1", fill(TOP)).await?;
    assert_eq!(result["status"], "origin_mismatch", "{result}");
    // The exact origins get the values once; a replay is refused.
    script.lock().unwrap().push("fill");
    let result = call(&admin, "general", "pay.fill", "t1", fill(TOP)).await?;
    assert_eq!(result["status"], "filled", "{result}");
    assert_eq!(
        result["filled"],
        json!(["number", "expiry", "cvc"]),
        "unknown kinds are dropped: {result}"
    );
    // A secure keypad after the fields hands the tab to the user.
    script.lock().unwrap().push("keypad");
    let result = call(&admin, "general", "pay.fill", "t1", fill(TOP)).await?;
    assert_eq!(
        (result["status"].as_str(), result["reason"].as_str()),
        (Some("user_required"), Some("secure_keypad")),
        "{result}"
    );
    let seen = pulls.lock().unwrap().clone();
    assert_eq!(
        seen.iter().map(|(status, _)| *status).collect::<Vec<_>>(),
        [403, 200, 410, 200],
        "{seen:?}"
    );
    assert!(
        seen[1].1.contains(CANARY) && seen[1].1.contains("737") && seen[1].1.contains("\"pin2\"")
    );
    let sent = host.last("pay.fill").unwrap();
    assert!(
        !sent.to_string().contains(CANARY),
        "the stream carries a token, never the number"
    );
    assert_eq!(sent["args"]["frame_origins"], json!([PAY]));
    assert_eq!(sent["args"]["meta"]["exp_month"], 12);

    // Traveler details pull the same way; the resident number never reaches a result.
    script.lock().unwrap().push("traveler");
    let filled = call(
        &admin,
        "general",
        "traveler.fill",
        "t1",
        json!({"item_id": traveler_id, "top_origin": TOP, "frame_origins": []}),
    )
    .await?;
    assert_eq!(filled["status"], "filled", "{filled}");
    let last = pulls.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.0, 200);
    assert!(
        last.1.contains(RRN) && last.1.contains("M12345678"),
        "{}",
        last.1.len()
    );

    let view = admin
        .send(Method::GET, "/security/vault", None, &[])
        .await?;
    assert_eq!(
        view.data()["cards"][0]["uses"][0]["result"],
        "user_required:secure_keypad",
        "{}",
        view.text
    );
    assert_eq!(view.data()["cards"][0]["uses"][0]["origin"], TOP);
    for text in [view.text.clone(), s.gw.get("/events?limit=500").await?.text] {
        assert!(!text.contains(CANARY) && !text.contains(RRN));
    }
    for (kind, id) in [("cards", &card_id), ("travelers", &traveler_id)] {
        let deleted = admin
            .send(
                Method::DELETE,
                &format!("/security/vault/{kind}/{id}"),
                None,
                &[],
            )
            .await?;
        assert_eq!(deleted.status, 200, "{}", deleted.text);
    }
    let view = admin
        .send(Method::GET, "/security/vault", None, &[])
        .await?;
    assert_eq!(view.data()["cards"], json!([]));
    for canary in [CANARY, RRN] {
        super::super::canary_absent(&s.sandbox.data, canary, &s.agent.logs());
        super::super::canary_absent(&s.sandbox.logs, canary, "");
    }
    drop(cleanup);
    s.finish().await
}

/// Pulls the values as main would, per scripted case.
fn responder(
    admin: butler_e2e::e2e::security::AdminClient,
    pulls: Arc<Mutex<Vec<(u16, String)>>>,
    script: Arc<Mutex<Vec<&'static str>>>,
) -> super::super::host::Respond {
    Arc::new(move |frame: Value| {
        let (admin, pulls) = (admin.clone(), pulls.clone());
        let fills = matches!(frame["op"].as_str(), Some("pay.fill" | "traveler.fill"));
        let case = if fills {
            script.lock().unwrap().pop()
        } else {
            None
        };
        Box::pin(async move {
            let token = frame["args"]["fill_token"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let pull = |frames: Value| {
                let (admin, pulls, token) = (admin.clone(), pulls.clone(), token.clone());
                async move {
                    let reply = admin
                        .send(
                            Method::POST,
                            &format!("/internal/browser-host/vault/{token}"),
                            Some(json!({"origin": TOP, "frame_origins": frames})),
                            &[],
                        )
                        .await
                        .unwrap();
                    pulls
                        .lock()
                        .unwrap()
                        .push((reply.status, reply.text.clone()));
                }
            };
            match case {
                Some("look-alike") => {
                    pull(json!(["https://js.tosspayments.com.evil.test"])).await;
                    json!({"status":"origin_mismatch","url":CHECKOUT})
                }
                Some("fill") => {
                    pull(json!([PAY])).await;
                    pull(json!([PAY])).await;
                    json!({"status":"filled","url":CHECKOUT,"frame_origin":PAY,"filled":["number","expiry","cvc","secret_value"]})
                }
                Some("keypad") => {
                    pull(json!([TOP, PAY])).await;
                    json!({"status":"user_required","reason":"secure_keypad","url":CHECKOUT,"frame_origin":PAY,"filled":["number"],"missing":["pin2"]})
                }
                Some("traveler") => {
                    pull(json!([TOP])).await;
                    json!({"status":"filled","url":CHECKOUT,"filled":["full_name","rrn"]})
                }
                _ => json!({"status":"ok","tab":frame["tab"],"url":CHECKOUT}),
            }
        })
    })
}
