//! App DB table rebuilds on an existing database: an unrelated schema object
//! that no longer resolves never blocks a migration, and a migration that does
//! fail rolls back and names its cause in the service log.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use rusqlite::Connection;

const ORIGINS: &str = r#"["https://www.fixture-shop.test","https://login.fixture-shop.test"]"#;

fn app_db(s: &Scenario) -> Result<Connection, HarnessError> {
    Ok(Connection::open(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
    )?)
}

/// Returns the App DB to its state before the sign-in account rebuild, with
/// one saved sign-in and one autofill profile under its earlier table name.
fn seed_before_rebuilds(db: &Connection) -> Result<(), HarnessError> {
    db.execute_batch(
        "DELETE FROM browser_import_schema WHERE version=2;
         DELETE FROM browser_signin_identity;
         DROP INDEX browser_signin_entries_site;
         ALTER TABLE browser_autofill_profiles RENAME TO browser_traveler_profiles;
         INSERT INTO browser_traveler_profiles VALUES('profile-1','Self','{}','[]','2026-10-01',NULL);",
    )?;
    db.execute(
        "INSERT INTO browser_signin_entries(id,site,origins_json,username,policy,source,created_at,last_used_at)
         VALUES('entry-1','fixture-shop.test',?1,'owner','always','manual','2026-10-01T00:00:00Z','2026-10-02T00:00:00Z')",
        [ORIGINS],
    )?;
    Ok(())
}

/// A trigger whose target table was dropped later: it no longer resolves.
const ORPHANED_TRIGGER: &str = "CREATE TABLE leftover_rows(id TEXT);
     CREATE TABLE leftover_wakes(id TEXT);
     CREATE TRIGGER leftover_wake AFTER INSERT ON leftover_rows
       BEGIN INSERT INTO leftover_wakes VALUES(NEW.id); END;
     DROP TABLE leftover_wakes;";

fn count(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |row| row.get(0)).unwrap()
}

#[tokio::test]
async fn table_rebuilds_ignore_an_orphaned_trigger() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("APP-DB-ORPHANED-TRIGGER")?.start().await?;
    s.agent.terminate().await?;
    let db = app_db(&s)?;
    seed_before_rebuilds(&db)?;
    db.execute_batch(ORPHANED_TRIGGER)?;
    drop(db);

    s.gw = s.agent.start_again().await?;
    let db = app_db(&s)?;
    let entry: (
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
    ) = db.query_row(
        "SELECT site,origins_json,username,policy,source,created_at,last_used_at
         FROM browser_signin_entries WHERE id='entry-1'",
        [],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        },
    )?;
    assert_eq!(
        entry,
        (
            "fixture-shop.test".into(),
            ORIGINS.into(),
            "owner".into(),
            "always".into(),
            "manual".into(),
            "2026-10-01T00:00:00Z".into(),
            Some("2026-10-02T00:00:00Z".into()),
        ),
        "the saved sign-in survives the rebuild unchanged"
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM browser_signin_identity WHERE entry_id='entry-1' AND username='owner'"
        ),
        2,
        "every origin is indexed"
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM browser_import_schema WHERE version=2"
        ),
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('browser_signin_entries_site','leftover_wake')"
        ),
        2,
        "the rebuild indexes its table and leaves unrelated objects alone"
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM browser_autofill_profiles WHERE id='profile-1'"
        ),
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('browser_traveler_profiles','browser_signin_entries_v2')"
        ),
        0
    );
    drop(db);
    s.restart().await?;
    assert_eq!(
        count(&app_db(&s)?, "SELECT COUNT(*) FROM browser_signin_entries"),
        1
    );
    s.finish().await
}

#[tokio::test]
async fn a_failed_rebuild_rolls_back_and_logs_its_cause() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("APP-DB-REBUILD-FAILURE")?.start().await?;
    s.agent.terminate().await?;
    let db = app_db(&s)?;
    seed_before_rebuilds(&db)?;
    // The rebuild's last step cannot record its version in a view.
    db.execute_batch(
        "DROP TABLE browser_import_schema;
         CREATE VIEW browser_import_schema AS SELECT 1 AS version;",
    )?;
    drop(db);

    let started = s.agent.start_again().await;
    assert!(started.is_err(), "the failed migration must stop the start");
    let logs = s.agent.logs();
    assert!(
        logs.contains("cause=") && logs.contains("cannot modify browser_import_schema"),
        "the service log names the SQLite cause: {logs}"
    );
    let db = app_db(&s)?;
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM browser_signin_entries WHERE id='entry-1'"
        ),
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM sqlite_master WHERE name='browser_signin_entries_v2'"
        ),
        0,
        "the partial rebuild rolled back"
    );
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn existing_assets_gain_default_pixel_ratio() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("APP-DB-ASSET-RATIO")?.start().await?;
    s.agent.terminate().await?;
    let db = app_db(&s)?;
    db.execute_batch(
        "ALTER TABLE app_assets DROP COLUMN pixel_ratio;
        INSERT INTO app_assets(id,sha256,mime,width,height,bytes,alt,source_url,created_at)
        VALUES('img_0123456789','hash','image/png',120,80,0,'','','2026-10-25');",
    )?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    let db = app_db(&s)?;
    let ratio: f64 = db.query_row(
        "SELECT pixel_ratio FROM app_assets WHERE id='img_0123456789'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(ratio, 1.0);
    drop(db);
    s.finish().await
}
