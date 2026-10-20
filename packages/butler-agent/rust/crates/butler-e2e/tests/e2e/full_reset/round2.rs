//! Second review regressions use real process replacement and isolated storage.
use super::*;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

async fn held(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.with_extension("held").exists() {
        assert!(Instant::now() < deadline, "apply boundary not reached");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn launcher_logs_and_recreated_sources_survive_interrupted_apply() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = setup("RESET-LAUNCHER")?;
    let release = setup.sandbox.root.join("release");
    let mut s = setup
        .env("BUTLER_APP_AGENT_LOG", "logs/butler-agent-app.log")
        .env("BUTLER_E2E_HOLD_POINT", "data_reset.move")
        .env("BUTLER_E2E_HOLD_RELEASE", release.display().to_string())
        .start()
        .await?;
    let root = s.sandbox.data.clone();
    let before = generation(&s).await?;
    fs::create_dir_all(root.join("logs"))?;
    for name in [
        "ordinary",
        "butler-agent-app.log",
        "butler-agent-app.log.1",
        "butler-agent-service.stdout.log",
        "butler-agent-service.stderr.log",
    ] {
        fs::write(root.join("logs").join(name), b"old private log")?;
    }
    let mut app = OpenOptions::new()
        .append(true)
        .open(root.join("logs/butler-agent-app.log"))?;
    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    s.agent.kill9()?;
    // Put a log move first to interrupt precisely after its durable rename.
    let path = root.join("state/full-reset.json");
    let mut journal: Value = serde_json::from_slice(&fs::read(&path)?).unwrap();
    journal["moves"]
        .as_array_mut()
        .unwrap()
        .sort_by_key(|p| match p.as_str().unwrap() {
            "logs" | "logs/ordinary" => 0,
            _ => 1,
        });
    fs::write(&path, journal.to_string())?;
    s.agent.start_process()?;
    held(&release).await;
    s.agent.kill9()?;
    fs::create_dir_all(root.join("logs"))?;
    fs::write(root.join("logs/ordinary"), b"recreated child")?;
    let mut launcher = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("logs/butler-agent-service.stdout.log"))?;
    launcher.write_all(b"relaunch private log")?;
    fs::write(&release, b"release")?;
    s.gw = s.agent.start_again().await?;
    assert_ne!(generation(&s).await?, before);
    cleaned(&root).await;
    assert!(!root.join("logs/ordinary").exists());
    assert!(!root.join("logs/butler-agent-app.log.1").exists());
    for name in [
        "butler-agent-app.log",
        "butler-agent-service.stdout.log",
        "butler-agent-service.stderr.log",
    ] {
        assert_eq!(fs::metadata(root.join("logs").join(name))?.len(), 0);
    }
    // The original handles still address the retained files.
    app.write_all(b"new app output")?;
    launcher.write_all(b"new service output")?;
    assert_eq!(
        fs::read(root.join("logs/butler-agent-app.log"))?,
        b"new app output"
    );
    assert_eq!(
        fs::read(root.join("logs/butler-agent-service.stdout.log"))?,
        b"new service output"
    );
    s.finish().await
}

#[tokio::test]
async fn failed_startup_apply_never_erases_later_data() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("RESET-STARTUP-FAILURE")?;
    let fault = setup.sandbox.root.join("fault");
    let mut s = setup
        .env("BUTLER_E2E_FILE_FAULT", "data_reset.plan")
        .env("BUTLER_E2E_FILE_FAULT_MARKER", fault.display().to_string())
        .start()
        .await?;
    let root = s.sandbox.data.clone();
    let before = generation(&s).await?;
    fs::write(root.join("old-data"), b"old")?;
    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    s.agent.kill9()?;
    s.gw = s.agent.start_again().await?;
    assert!(fault.exists());
    assert_eq!(generation(&s).await?, before);
    assert_eq!(fs::read(root.join("old-data"))?, b"old");
    assert!(
        !root.join("state/full-reset.json").exists(),
        "startup failure retained a deferred reset"
    );
    fs::write(root.join("later-data"), b"created after failure")?;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(generation(&s).await?, before);
    assert_eq!(fs::read(root.join("later-data"))?, b"created after failure");
    s.finish().await
}

#[tokio::test]
async fn cleanup_failure_does_not_block_secrets_or_trash() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("RESET-INDEPENDENT-CLEANUP")?;
    butler_platform::secrets::prepare_system_keychain_for_test(&setup.sandbox.home)?;
    let mut s = setup.start().await?;
    let root = s.sandbox.data.clone();
    // Register a real cache, then make its removal fail portably after snapshot.
    seed::seed(&s).await?;
    let cache = s
        .sandbox
        .workspace
        .join("registered-project/.butler/hot-cache.md");
    let key = butler_platform::secrets::SecretKey::new(
        &format!(
            "com.hexpy.butler.reset.{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        ),
        "pending",
    )
    .unwrap();
    butler_platform::secrets::seed_system_secret_for_test_apps(
        &s.sandbox.home,
        &key,
        "fixture",
        &[&s.sandbox.binary],
    )?;
    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    let path = root.join("state/full-reset.json");
    let mut journal: Value = serde_json::from_slice(&fs::read(&path)?).unwrap();
    journal["secret_keys"]
        .as_array_mut()
        .unwrap()
        .push(json!({"service":key.service(),"account":key.account()}));
    fs::write(&path, journal.to_string())?;
    fs::remove_file(&cache)?;
    fs::create_dir(&cache)?;
    fs::write(cache.join("blocked"), b"blocked")?;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let pending: Value = serde_json::from_slice(&fs::read(&path)?).unwrap();
        if !butler_platform::secrets::system_secret_present_for_test(&s.sandbox.home, &key)?
            && pending["secret_keys"] == json!([])
            && pending["pending_trash"] == json!([])
            && pending["kept_logs"] == json!([])
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "independent cleanup was blocked by cache failure"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let journal: Value = serde_json::from_slice(&fs::read(&path)?).unwrap();
    assert_eq!(journal["secret_keys"], json!([]));
    let caches: Vec<PathBuf> =
        serde_json::from_value(journal["project_hot_caches"].clone()).unwrap();
    assert_eq!(caches, vec![cache.clone()]);
    assert_eq!(journal["pending_trash"], json!([]));
    assert_eq!(journal["kept_logs"], json!([]));
    assert!(!fs::read_dir(&root)?.any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".reset-trash-")
    }));
    fs::remove_dir_all(&cache)?;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    cleaned(&root).await;
    s.finish().await
}

#[tokio::test]
async fn protected_user_folder_is_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    unsafe_root(true).await
}
#[tokio::test]
async fn adopted_unknown_root_is_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    unsafe_root(false).await
}
async fn unsafe_root(documents: bool) -> Result<(), HarnessError> {
    let mut setup = setup("RESET-UNSAFE-ROOT")?;
    if documents {
        setup.sandbox.data = setup.sandbox.home.join("Documents");
        fs::create_dir_all(&setup.sandbox.data)?;
    }
    let file = setup.sandbox.data.join("user-document.txt");
    fs::write(&file, b"user document")?;
    let s = setup.start().await?;
    let before = generation(&s).await?;
    let reply = request(&s, &nonce(&s).await?).await?;
    assert_eq!(reply.status, 409, "{}", reply.text);
    assert_eq!(reply.error_code(), Some("full_reset_unsafe_root"));
    assert_eq!(fs::read(&file)?, b"user document");
    assert_eq!(generation(&s).await?, before);
    assert!(!s.sandbox.data.join("state/full-reset.json").exists());
    assert!(!s.sandbox.data.join("state/data-root-owner.json").exists());
    s.finish().await
}

#[tokio::test]
async fn orphan_trash_is_cleaned_without_a_journal_and_links_are_unlinked()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("RESET-ORPHAN-TRASH")?.start().await?;
    s.agent.terminate().await?;
    let root = s.sandbox.data.clone();
    let outside = s.sandbox.workspace.join("outside");
    fs::create_dir(&outside)?;
    fs::write(outside.join("keep"), b"keep")?;
    fs::create_dir(root.join(".reset-trash-orphan"))?;
    fs::write(root.join(".reset-trash-orphan/private"), b"private")?;
    butler_platform::secure_fs::symlink(&outside, &root.join(".reset-trash-link"))?;
    s.gw = s.agent.start_again().await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while root.join(".reset-trash-orphan").exists()
        || fs::symlink_metadata(root.join(".reset-trash-link")).is_ok()
    {
        assert!(Instant::now() < deadline, "orphan trash remains");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(fs::read(outside.join("keep"))?, b"keep");
    assert!(!root.join("state/full-reset.json").exists());
    s.finish().await
}

#[tokio::test]
async fn corrupt_journal_diagnostic_names_its_path() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for contents in [
        "{",
        r#"{"schema":7,"id":"bad","phase":"requested","created_at":"now","secret_keys":[],"project_hot_caches":[],"moves":[],"old_generation":"old","new_generation":"new","retried":false}"#,
    ] {
        let mut s = setup("RESET-CORRUPT-JOURNAL")?.start().await?;
        s.agent.terminate().await?;
        let path = s.sandbox.data.join("state/full-reset.json");
        fs::write(&path, contents)?;
        assert!(
            s.agent.start_again().await.is_err(),
            "corrupt journal served"
        );
        assert!(
            s.agent.logs().contains(&path.display().to_string()),
            "journal path missing from diagnostic"
        );
        assert_eq!(fs::read_to_string(&path)?, contents);
        fs::remove_file(&path)?;
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn ownership_migrates_known_roots_but_never_unknown_entries_or_links()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("RESET-OWNERSHIP-MIGRATION")?.start().await?;
    let root = s.sandbox.data.clone();
    let marker = root.join("state/data-root-owner.json");
    assert!(
        marker.exists(),
        "Butler initialization did not publish ownership"
    );
    s.agent.terminate().await?;
    fs::remove_file(&marker)?;
    s.gw = s.agent.start_again().await?;
    assert!(marker.exists(), "known Butler roots did not migrate");
    s.agent.terminate().await?;
    fs::remove_file(&marker)?;
    butler_platform::secure_fs::symlink(&s.sandbox.workspace, &root.join("updates"))?;
    s.gw = s.agent.start_again().await?;
    assert!(!marker.exists(), "migration accepted a symlink");
    let reply = request(&s, &nonce(&s).await?).await?;
    assert_eq!(reply.error_code(), Some("full_reset_unsafe_root"));
    s.finish().await
}

#[tokio::test]
async fn app_log_retention_requires_a_plain_file() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("RESET-LOG-FILE-TYPE")?;
    let directory = setup.sandbox.data.join("logs/app-output");
    fs::create_dir_all(&directory)?;
    fs::write(directory.join("keep-until-accepted"), b"private")?;
    let s = setup
        .env("BUTLER_APP_AGENT_LOG", "logs/app-output")
        .start()
        .await?;
    let reply = request(&s, &nonce(&s).await?).await?;
    assert_eq!(reply.status, 409, "{}", reply.text);
    assert!(!s.sandbox.data.join("state/full-reset.json").exists());
    assert_eq!(fs::read(directory.join("keep-until-accepted"))?, b"private");
    s.finish().await
}
