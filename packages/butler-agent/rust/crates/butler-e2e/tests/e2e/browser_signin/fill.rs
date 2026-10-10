//! Sign-in fill with the system keychain: the token is single use and bound to
//! the entry's exact origins, the password reaches only the host's credential
//! pull, and a canary never appears in results, events, logs or the data folder.
//! Opt-in like the platform's system-store contract check
//! (`BUTLER_PLATFORM_SYSTEM_SECRETS=1`); items live under a service suffixed by
//! the scenario's data folder and are deleted before the scenario ends.
use super::host::{admin, attach, call, snapshot, tab};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) const CANARY: &str = "canary-pw-5b1e9c-fill";
const LOGIN: &str = "https://login.fixture-shop.test/session";

pub(super) fn keychain_opt_in() -> bool {
    std::env::var("BUTLER_PLATFORM_SYSTEM_SECRETS").as_deref() == Ok("1")
}

/// Deletes every registered sign-in (and its keychain item) through the
/// scenario's own route, also when an assertion fails first.
pub(super) struct Cleanup {
    admin: butler_e2e::e2e::security::AdminClient,
    ids: Vec<String>,
}

impl Cleanup {
    pub(super) fn new(admin: &butler_e2e::e2e::security::AdminClient) -> Self {
        Self {
            admin: admin.clone(),
            ids: Vec::new(),
        }
    }
    pub(super) fn track(&mut self, id: &str) {
        self.ids.push(id.to_owned());
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let (admin, ids) = (self.admin.clone(), std::mem::take(&mut self.ids));
        let _ = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                for id in ids {
                    let _ = admin
                        .send(
                            Method::DELETE,
                            &format!("/security/signins/{id}"),
                            None,
                            &[],
                        )
                        .await;
                }
            });
        })
        .join();
    }
}

/// The isolated home reaches the user's keychain folder only through this
/// opt-in link (`BUTLER_E2E_KEYCHAINS`); nothing else of the real home.
fn link_keychains(home: &std::path::Path) -> Result<(), HarnessError> {
    if let Some(keychains) = std::env::var_os("BUTLER_E2E_KEYCHAINS") {
        std::fs::create_dir_all(home.join("Library"))?;
        butler_platform::secure_fs::symlink(
            std::path::Path::new(&keychains),
            &home.join("Library/Keychains"),
        )?;
    }
    Ok(())
}

/// A scenario whose sign-in store is the system keychain.
pub(super) async fn keychain_scenario(id: &str) -> Result<Scenario, HarnessError> {
    keychain_scenario_with(id, None).await
}

pub(super) async fn keychain_scenario_with(
    id: &str,
    cassette: Option<butler_e2e::e2e::cassette::Cassette>,
) -> Result<Scenario, HarnessError> {
    let mut setup = Setup::new(id)?.env("BUTLER_SECRET_STORE", "");
    link_keychains(&setup.sandbox.home)?;
    if let Some(cassette) = cassette {
        setup = setup.stub_cassette(cassette);
    }
    let s = setup.start().await?;
    let path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    config["secrets"] = json!({"store": "system"});
    std::fs::write(&path, serde_json::to_vec_pretty(&config)?)?;
    Ok(s)
}

#[tokio::test]
async fn signin_fill_pulls_the_password_once_for_the_right_origin() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        keychain_opt_in(),
        "system keychain check needs BUTLER_PLATFORM_SYSTEM_SECRETS=1"
    );
    let s = keychain_scenario("BROWSER-SIGNIN-FILL").await?;
    let admin = admin(&s);
    assert_eq!(
        admin
            .send(Method::GET, "/security/signins", None, &[])
            .await?
            .data()["available"],
        true
    );
    let added = admin
        .send(Method::POST, "/security/signins", Some(json!({"origin":"https://login.fixture-shop.test","username":"owner@fixture.test","password":CANARY})), &[])
        .await?;
    assert_eq!(added.status, 200, "{}", added.text);
    let entry = added.data()["id"].as_str().unwrap().to_owned();
    let mut cleanup = Cleanup::new(&admin);
    cleanup.track(&entry);
    assert!(!added.text.contains(CANARY));

    let pulls = Arc::new(Mutex::new(Vec::<(u16, String)>::new()));
    let script = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let host = attach(&s, responder(admin.clone(), pulls.clone(), script.clone())).await?;
    snapshot(
        &admin,
        json!([tab("t1", "conversation:general", LOGIN, "agent")]),
    )
    .await?;
    let looked = call(&admin, "general", "signin.lookup", "t1", json!({})).await?;
    assert_eq!(looked["reason"], "signed_in_grant_required", "{looked}");
    call(
        &admin,
        "general",
        "signin.grant",
        "",
        json!({"site":"fixture-shop.test"}),
    )
    .await?;
    let looked = call(&admin, "general", "signin.lookup", "t1", json!({})).await?;
    assert_eq!(looked["entry"]["id"], entry.as_str(), "{looked}");
    assert_eq!(looked["entry"]["policy"], "ask");

    // Another origin of the same site burns the token without the password.
    script.lock().unwrap().push("look-alike");
    let result = call(
        &admin,
        "general",
        "signin.fill",
        "t1",
        json!({"entry_id": entry}),
    )
    .await?;
    assert_eq!(result["status"], "origin_mismatch", "{result}");
    // The right origin gets it exactly once; a replay of the token fails.
    script.lock().unwrap().push("fill");
    let result = call(
        &admin,
        "general",
        "signin.fill",
        "t1",
        json!({"entry_id": entry}),
    )
    .await?;
    assert_eq!(result["status"], "filled", "{result}");
    // MFA after the password hands the tab to the user.
    script.lock().unwrap().push("mfa");
    let result = call(
        &admin,
        "general",
        "signin.fill",
        "t1",
        json!({"entry_id": entry}),
    )
    .await?;
    assert_eq!(
        (result["status"].as_str(), result["reason"].as_str()),
        (Some("user_required"), Some("mfa")),
        "{result}"
    );
    let pulls = pulls.lock().unwrap().clone();
    assert_eq!(
        pulls.iter().map(|(status, _)| *status).collect::<Vec<_>>(),
        [403, 200, 410, 200],
        "{pulls:?}"
    );
    assert_eq!(pulls[1].1, CANARY);
    let fill = host.last("signin.fill").unwrap();
    assert!(
        !fill.to_string().contains(CANARY),
        "the stream carries a token, never the password"
    );
    assert_eq!(
        fill["args"]["origins"],
        json!(["https://login.fixture-shop.test"])
    );

    // Policy never refuses before any token.
    let updated = admin
        .send(
            Method::PATCH,
            &format!("/security/signins/{entry}"),
            Some(json!({"policy":"never"})),
            &[],
        )
        .await?;
    assert_eq!(updated.status, 200, "{}", updated.text);
    let looked = call(&admin, "general", "signin.lookup", "t1", json!({})).await?;
    assert_eq!(looked["reason"], "signin_policy_never", "{looked}");

    let rows = admin
        .send(Method::GET, "/security/signins", None, &[])
        .await?;
    assert!(!rows.text.contains(CANARY));
    let uses = rows.data()["sites"][0]["uses"].clone();
    assert_eq!(uses[0]["result"], "user_required:mfa", "{uses}");
    let events = s.gw.get("/events?limit=500").await?;
    assert!(!events.text.contains(CANARY));
    let deleted = admin
        .send(
            Method::DELETE,
            &format!("/security/signins/{entry}"),
            None,
            &[],
        )
        .await?;
    assert_eq!(deleted.status, 200, "{}", deleted.text);
    super::canary_absent(&s.sandbox.data, CANARY, &s.agent.logs());
    s.finish().await
}

/// Pulls the password as main would, per scripted case.
fn responder(
    admin: butler_e2e::e2e::security::AdminClient,
    pulls: Arc<Mutex<Vec<(u16, String)>>>,
    script: Arc<Mutex<Vec<&'static str>>>,
) -> super::host::Respond {
    Arc::new(move |frame: Value| {
        let (admin, pulls) = (admin.clone(), pulls.clone());
        let case = if frame["op"] == "signin.fill" {
            script.lock().unwrap().pop()
        } else {
            None
        };
        Box::pin(async move {
            let token = frame["args"]["fill_token"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let pull = |origin: &'static str| {
                let (admin, pulls, token) = (admin.clone(), pulls.clone(), token.clone());
                async move {
                    let reply = admin
                        .send(
                            Method::POST,
                            &format!("/internal/browser-host/credentials/{token}"),
                            Some(json!({"origin": origin})),
                            &[],
                        )
                        .await
                        .unwrap();
                    let password = reply.body["password"].as_str().unwrap_or("").to_owned();
                    pulls.lock().unwrap().push((reply.status, password));
                }
            };
            match case {
                Some("look-alike") => {
                    pull("https://files.fixture-shop.test").await;
                    json!({"status":"origin_mismatch","url":"https://files.fixture-shop.test/login"})
                }
                Some("fill") => {
                    pull("https://login.fixture-shop.test").await;
                    pull("https://login.fixture-shop.test").await;
                    json!({"status":"filled","url":"https://www.fixture-shop.test/"})
                }
                Some("mfa") => {
                    pull("https://login.fixture-shop.test").await;
                    json!({"status":"user_required","reason":"mfa","url":LOGIN})
                }
                _ => json!({"status":"ok","tab":frame["tab"],"url":LOGIN}),
            }
        })
    })
}
