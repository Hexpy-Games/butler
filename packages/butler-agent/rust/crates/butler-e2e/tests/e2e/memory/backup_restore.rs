use std::{fs, time::Duration};

use butler_e2e::e2e::{
    HarnessError,
    fake_butler_cloud::FakeButlerCloud,
    gateway::Reply,
    scenario::{Fixture, Scenario, Setup},
    security::AdminClient,
};
use butler_platform::process_control::usage;
use reqwest::Method;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

use super::{batch, memory_stubs};

const ACCOUNT: &str = "/setup/butler-account";
const BACKUP: &str = "/setup/butler-backup";
const RECALL: &str = "What is my bike lock code? Call recall_memory with cue bike lock code.";

#[tokio::test]
async fn backup_restore_01_restores_conversations_and_memory_into_an_empty_butler()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeButlerCloud::start().await?;
    let (setup, remember, code) = batch::setup("BACKUP-RESTORE-01-A")?;
    let a = gate(setup, &fake)?.start().await?;
    crate::memory_wiring::bootstrap(&a.sandbox.data).await;
    let (_, turn) = a.turn("general", &remember).await?;
    assert_eq!(turn["state"], "delivered");
    memory_stubs::text_complete(&a.sandbox.data, 1).await?;
    batch::recall(&a, "general", RECALL).await?;
    memory_stubs::vectors_complete(&a.sandbox.data, 2).await?;
    sign_in(&a).await?;
    fake.set_plan("plus");
    let recovery = back_up(&a).await?;
    // Every chunk id of the run fits one `missing` request.
    let asked = fake
        .seen()
        .iter()
        .filter(|seen| *seen == "POST /v1/backup/chunks/missing")
        .count();
    assert_eq!(asked, 1);
    let original = texts(&a).await?;
    let units = memory_stubs::unit_states(&a.sandbox.data)?;
    let completed = {
        let db = Connection::open_with_flags(
            memory_stubs::graph_path(&a.sandbox.data)?,
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let mut rows =
            db.prepare("SELECT unit_id FROM memory_vector_units WHERE state='complete'")?;
        rows.query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let (setup, _, _) = batch::setup("BACKUP-RESTORE-01-B")?;
    let mut b = gate(setup.placeholder("NONCE", code), &fake)?
        .start()
        .await?;
    sign_in(&b).await?;
    // Plain status stays local; only a refresh asks the service.
    assert_eq!(backup(&b, None).await?.data()["state"], "off");
    let refreshed = backup(&b, Some(json!({"action": "refresh"}))).await?;
    assert_eq!(refreshed.data()["state"], "restore_available");
    let typo = format!("!{}", &recovery[1..]);
    let reply = backup(&b, Some(json!({"action": "restore", "recovery_key": typo}))).await?;
    assert_eq!(
        (reply.status, reply.error_code()),
        (400, Some("recovery_key_invalid"))
    );
    let wrong = "000000000000000000000000000000000000000000000EPX";
    let reply = backup(
        &b,
        Some(json!({"action": "restore", "recovery_key": wrong})),
    )
    .await?;
    assert_eq!(
        (reply.status, reply.error_code()),
        (400, Some("recovery_key_wrong"))
    );
    let token = fs::read(b.sandbox.data.join("auth/butler-account.json"))?;
    fake.flip_chunks();
    let reply = backup(
        &b,
        Some(json!({"action": "restore", "recovery_key": &recovery})),
    )
    .await?;
    assert_eq!(reply.status, 200);
    let failed = wait(&b, "failed").await?;
    assert_eq!(failed["error"], "chunk_corrupt");
    fake.flip_chunks();
    // Lowercase, separators and O/L for 0/1 parse as the same key.
    let typed = recovery
        .to_ascii_lowercase()
        .replace('0', "o")
        .replace('1', "l");
    let typed: Vec<_> = typed
        .as_bytes()
        .chunks(6)
        .map(|group| String::from_utf8_lossy(group))
        .collect();
    restore(&mut b, &typed.join(" - ")).await?;
    if let Some(workers) = usage::embedding_children(b.agent.pid().unwrap())? {
        assert!(workers.is_empty(), "restart preloaded an embedding worker");
    }
    assert!(!b.sandbox.data.join("restore-staging").exists());
    assert_eq!(texts(&b).await?, original);
    assert_eq!(memory_stubs::unit_states(&b.sandbox.data)?, (units.1, 0));
    let graph = memory_stubs::graph_path(&b.sandbox.data)?;
    assert!(!graph.with_file_name("butler.lance").exists());
    assert_eq!(
        backup(&b, None).await?.data()["memory_search_preparing"],
        true
    );
    let token_preserved = fs::read(b.sandbox.data.join("auth/butler-account.json"))? == token;
    assert!(token_preserved);
    batch::recall(&b, "general", RECALL).await?;
    memory_stubs::vectors_complete(&b.sandbox.data, 1).await?;
    {
        let db = Connection::open_with_flags(&graph, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut rows = db.prepare("SELECT state FROM memory_vector_units WHERE unit_id=?1")?;
        for unit in &completed {
            assert_eq!(
                rows.query_row([unit], |row| row.get::<_, String>(0))?,
                "complete"
            );
        }
    }
    let status = backup(&b, None).await?;
    assert_eq!(status.data()["memory_search_preparing"], false);
    assert_eq!(status.data()["state"], "idle");
    a.finish().await?;
    b.finish().await
}

#[tokio::test]
async fn backup_restore_02_vault_item_survives_restore() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_PLATFORM_SYSTEM_SECRETS").as_deref() == Ok("1"),
        "system keychain check needs BUTLER_PLATFORM_SYSTEM_SECRETS=1"
    );
    let fake = FakeButlerCloud::start().await?;
    let a = vault_host("BACKUP-RESTORE-02-A", &fake).await?;
    let enabled = a.gw.post("/setup/butler-vault/enable", json!({})).await?;
    assert_eq!(enabled.data()["state"], "protected");
    let saved = admin(&a).send(Method::POST, "/security/signins", Some(json!({
        "origin": "https://example.com", "username": "backup@example.com", "password": "vault-restore-secret",
    })), &[]).await?;
    assert_eq!(saved.status, 200);
    sign_in(&a).await?;
    fake.set_plan("plus");
    let recovery = back_up(&a).await?;
    let mut b = vault_host("BACKUP-RESTORE-02-B", &fake).await?;
    sign_in(&b).await?;
    restore(&mut b, &recovery).await?;
    let signins = admin(&b)
        .send(Method::GET, "/security/signins", None, &[])
        .await?;
    assert_eq!(signins.status, 200);
    assert!(
        signins.data()["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |item| item["id"] == saved.data()["id"] && item["username"] == "backup@example.com"
            )
    );
    for path in ["auth/vault.age.prev", "auth/vault-key.age"] {
        assert!(!b.sandbox.data.join(path).exists());
    }
    a.finish().await?;
    b.finish().await
}

fn gate(setup: Setup, cloud: &FakeButlerCloud) -> Result<Setup, HarnessError> {
    let root = setup.sandbox.data.join("gateways");
    fs::create_dir_all(&root)?;
    fs::write(
        root.join("app.json"),
        json!({"config": {"butlerAccountEnabled": true}}).to_string(),
    )?;
    Ok(setup.env("BUTLER_CLOUD_API_URL", &cloud.url))
}

async fn vault_host(name: &str, cloud: &FakeButlerCloud) -> Result<Scenario, HarnessError> {
    let setup = gate(
        Setup::new(name)?
            .fixture(Fixture::Empty)
            .env("BUTLER_SECRET_STORE", ""),
        cloud,
    )?;
    butler_platform::secrets::prepare_system_keychain_for_test(&setup.sandbox.home)?;
    fs::write(
        setup.sandbox.data.join("butler.config.json"),
        json!({"secrets":{"store":"system"}}).to_string(),
    )?;
    setup.start().await
}

fn admin(scenario: &Scenario) -> AdminClient {
    AdminClient::new(
        scenario.gw.clone(),
        scenario.agent.launch.admin_credential().unwrap(),
    )
}

async fn sign_in(scenario: &Scenario) -> Result<(), HarnessError> {
    let reply = admin(scenario)
        .send(
            Method::POST,
            ACCOUNT,
            Some(json!({"action":"verify", "email":"user@example.com", "code":"123456"})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200);
    Ok(())
}

async fn backup(scenario: &Scenario, body: Option<Value>) -> Result<Reply, HarnessError> {
    let method = if body.is_some() {
        Method::POST
    } else {
        Method::GET
    };
    admin(scenario).send(method, BACKUP, body, &[]).await
}

async fn back_up(scenario: &Scenario) -> Result<String, HarnessError> {
    let reply = backup(scenario, Some(json!({"action": "create_key"}))).await?;
    assert_eq!(reply.status, 200);
    let recovery = reply.data()["recovery_key"].as_str().unwrap().to_owned();
    assert_eq!(recovery.len(), 48);
    assert_eq!(
        backup(scenario, Some(json!({"action": "start"})))
            .await?
            .status,
        200
    );
    wait(scenario, "idle").await?;
    Ok(recovery)
}

async fn restore(scenario: &mut Scenario, recovery: &str) -> Result<(), HarnessError> {
    let reply = backup(
        scenario,
        Some(json!({"action": "restore", "recovery_key": recovery})),
    )
    .await?;
    assert_eq!(reply.status, 200);
    wait(scenario, "restore_ready").await?;
    scenario.restart().await
}

async fn wait(scenario: &Scenario, state: &str) -> Result<Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let status = backup(scenario, None).await?;
            assert_eq!(status.status, 200);
            let view = status.data();
            if state != "failed" {
                assert_ne!(view["state"], "failed", "{view}");
            }
            if view["state"] == state && (state != "idle" || view["last_backup_at"].is_string()) {
                return Ok(view.clone());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("backup or restore reaches its terminal state")
}

async fn texts(scenario: &Scenario) -> Result<Vec<Value>, HarnessError> {
    Ok(scenario
        .gw
        .messages("general")
        .await?
        .into_iter()
        .map(|message| message["text"].clone())
        .collect())
}
