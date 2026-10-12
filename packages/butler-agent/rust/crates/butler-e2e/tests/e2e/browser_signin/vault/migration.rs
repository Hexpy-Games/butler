//! Existing metadata, allowances and keychain entries survive the profile rename.
use super::{admin, attach, call, snapshot, tab, vault_scenario};
use butler_e2e::e2e::HarnessError;
use butler_platform::secrets::{
    SecretKey, delete_system_secret_for_test, system_secret_present_for_test,
};
use reqwest::Method;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

struct Keys(std::path::PathBuf, Vec<SecretKey>);
impl Keys {
    fn cleanup(&mut self) -> Result<(), HarnessError> {
        let mut failed = false;
        for key in self.1.drain(..) {
            failed |= delete_system_secret_for_test(&self.0, &key).is_err();
        }
        if failed {
            return Err(butler_e2e::e2e::harness_error(
                "test keychain cleanup failed",
            ));
        }
        Ok(())
    }
}
impl Drop for Keys {
    fn drop(&mut self) {
        if self.cleanup().is_err() {
            eprintln!("test keychain cleanup failed");
        }
    }
}

#[tokio::test]
async fn autofill_migrates_metadata_sites_and_secrets_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        super::super::fill::keychain_opt_in(),
        "system keychain opt-in required"
    );
    let mut s = vault_scenario("AUTOFILL-MIGRATION", None).await?;
    s.agent.terminate().await?;
    let id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute_batch(
        "ALTER TABLE browser_autofill_profiles RENAME TO browser_traveler_profiles;
      DROP TABLE browser_vault_sites;
      CREATE TABLE browser_vault_sites(kind TEXT CHECK(kind IN ('card','traveler')),
        item_id TEXT,site TEXT,created_at TEXT,PRIMARY KEY(kind,item_id,site));",
    )?;
    db.execute(
        "INSERT INTO browser_traveler_profiles(id,nickname,details_json,extras_json,created_at)
      VALUES(?1,'Self',?2,'[\"birth_date\",\"passport_number\"]','2026-10-01')",
        rusqlite::params![
            id,
            json!({"name":"Sample Person","email":"self@example.test"}).to_string()
        ],
    )?;
    db.execute(
        "INSERT INTO browser_vault_sites VALUES('traveler',?1,'example.test','2026-10-01')",
        [id],
    )?;
    drop(db);
    let root = std::fs::canonicalize(&s.sandbox.data)?;
    let hash = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
    let old = secret(SecretKey::new(
        &format!("com.hexpy.butler.traveler.{}", &hash[..12]),
        id,
    ))?;
    let new = secret(SecretKey::new(
        &format!("com.hexpy.butler.autofill.{}", &hash[..12]),
        id,
    ))?;
    let mut keys = Keys(s.sandbox.home.clone(), vec![old, new]);
    butler_platform::secrets::seed_system_secret_for_test_apps(
        &keys.0,
        &keys.1[0],
        r#"{"birth_date":"1990-01-01","passport_number":"P12345678"}"#,
        &[&s.sandbox.binary, &std::env::current_exe()?],
    )?;
    s.gw = s.agent.start_again().await?;
    let admin = admin(&s);
    let view = admin
        .send(Method::GET, "/security/vault", None, &[])
        .await?;
    assert_eq!(view.status, 200, "{}", view.text);
    assert_eq!(
        view.data()["available"],
        true,
        "a real test keychain is available"
    );
    assert_eq!(view.data()["profiles"][0]["id"], id);
    assert_eq!(view.data()["profiles"][0]["sites"], json!(["example.test"]));
    assert!(
        !system_secret_present_for_test(&keys.0, &keys.1[0])?,
        "legacy secret removed"
    );
    verify_copy(&s, &admin, id).await?;
    let denied = admin
        .send(
            Method::POST,
            &format!("/security/vault/profiles/{id}/reveal"),
            Some(json!({"locale":"ko"})),
            &[],
        )
        .await?;
    assert_eq!(denied.status, 403, "OS authentication must deny reveal");
    s.restart().await?;
    let again = admin
        .send(Method::GET, "/security/vault", None, &[])
        .await?;
    assert_eq!(again.data()["profiles"].as_array().unwrap().len(), 1);
    assert!(!system_secret_present_for_test(&keys.0, &keys.1[0])?);
    keys.cleanup()?;
    drop(keys);
    s.finish().await
}

fn secret<T>(result: Result<T, butler_platform::secrets::SecretError>) -> Result<T, HarnessError> {
    result.map_err(|_| butler_e2e::e2e::harness_error("test keychain operation failed"))
}

async fn verify_copy(
    s: &butler_e2e::e2e::scenario::Scenario,
    admin: &butler_e2e::e2e::security::AdminClient,
    id: &str,
) -> Result<(), HarnessError> {
    let pull_admin = admin.clone();
    let host = attach(s, Arc::new(move |frame: Value| {
        let admin = pull_admin.clone();
        Box::pin(async move {
            let token = frame["args"]["fill_token"].as_str().unwrap();
            let pulled = admin.send(Method::POST, &format!("/internal/browser-host/vault/{token}"),
                Some(json!({"origin":"https://forms.example.test","frame_origins":["https://forms.example.test"]})), &[]).await.unwrap();
            assert_eq!(pulled.status, 200);
            let copied: Value = serde_json::from_str(&pulled.text).unwrap();
            assert!(copied == json!({"birth_date":"1990-01-01","passport_number":"P12345678"}),
                "the complete copy reached the trusted host");
            json!({"status":"filled","url":"https://forms.example.test","filled":["birth_date","passport_number"]})
        })
    })).await?;
    snapshot(
        admin,
        json!([tab("t1", "agent", "https://forms.example.test")]),
    )
    .await?;
    let result = call(admin, "general", "autofill.fill", "t1",
        json!({"item_id":id,"top_origin":"https://forms.example.test","frame_origins":[],
            "targets":[{"ref":"f0-e1","field":"birth_date"},{"ref":"f0-e2","field":"passport_number"}]})).await?;
    assert_eq!(result["status"], "filled");
    assert!(host.ops().contains(&"autofill.fill".to_owned()));
    Ok(())
}

#[tokio::test]
async fn autofill_migration_merges_both_creation_orders() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for legacy_first in [true, false] {
        let mut s = butler_e2e::e2e::scenario::Setup::new("AUTOFILL-MERGE")?
            .start()
            .await?;
        s.agent.terminate().await?;
        let db =
            rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
        db.execute_batch("DROP TABLE browser_autofill_profiles;")?;
        let names = if legacy_first {
            ["browser_traveler_profiles", "browser_autofill_profiles"]
        } else {
            ["browser_autofill_profiles", "browser_traveler_profiles"]
        };
        for name in names {
            db.execute_batch(&format!(
                "CREATE TABLE {name} (
                id TEXT PRIMARY KEY,nickname TEXT NOT NULL,details_json TEXT NOT NULL,
                extras_json TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT);
                INSERT INTO {name} VALUES('shared','{name}','{{}}','[]','2026-10-01',NULL);
                INSERT INTO {name} VALUES('{name}','unique','{{}}','[]','2026-10-01',NULL);"
            ))?;
        }
        db.execute_batch(
            "DROP TABLE browser_vault_sites;
            CREATE TABLE browser_vault_sites(kind TEXT,item_id TEXT,site TEXT,created_at TEXT,
                PRIMARY KEY(kind,item_id,site));
            INSERT INTO browser_vault_sites VALUES('profile','shared','example.test','new');
            INSERT INTO browser_vault_sites VALUES('traveler','shared','example.test','old');",
        )?;
        drop(db);
        s.gw = s.agent.start_again().await?;
        for _ in 0..2 {
            let db =
                rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
            let count: i64 =
                db.query_row("SELECT COUNT(*) FROM browser_autofill_profiles", [], |r| {
                    r.get(0)
                })?;
            assert_eq!(count, 3);
            let nickname: String = db.query_row(
                "SELECT nickname FROM browser_autofill_profiles WHERE id='shared'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(nickname, "browser_autofill_profiles");
            let sites: i64 = db.query_row(
                "SELECT COUNT(*) FROM browser_vault_sites WHERE kind='profile'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(sites, 1);
            let old: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='browser_traveler_profiles')",
                [],
                |r| r.get(0),
            )?;
            assert!(!old);
            drop(db);
            s.restart().await?;
        }
        s.finish().await?;
    }
    Ok(())
}
