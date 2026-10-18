//! Unknown entries survive reset; only shared store boundaries authorize moves.
use super::*;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::PathBuf};

const UNKNOWN: &[&str] = &[
    "project-ledger/projects/local/record.md",
    "chat-output.txt",
    "user-folder/nested/file",
    "bin/keep",
    "updates/keep",
    "locks/keep",
    "cache/models/keep",
    "cache/browser/keep",
    "state/user-entry",
    "cache/user-entry",
    "app/user-entry",
    "app/runtime/user-entry",
    "workspace/chosen-project/source",
    "work/source",
    "plans/source",
    "projects/source",
];
fn seed_unknown(root: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>, HarnessError> {
    for name in UNKNOWN {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap())?;
        fs::write(path, format!("user bytes: {name}\0\n"))?;
    }
    hashes(root)
}
fn hashes(root: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>, HarnessError> {
    UNKNOWN
        .iter()
        .map(|name| {
            let path = PathBuf::from(name);
            Ok((
                path.clone(),
                Sha256::digest(fs::read(root.join(path))?).to_vec(),
            ))
        })
        .collect()
}
pub(super) async fn reset_and_restart(s: &mut Scenario) -> Result<(), HarnessError> {
    let before = generation(s).await?;
    let reply = request(s, &nonce(s).await?).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_ne!(generation(s).await?, before);
    cleaned(&s.sandbox.data).await;
    Ok(())
}

#[tokio::test]
async fn unknown_entries_and_links_survive_while_owned_stores_are_reset() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut s = setup("RESET-ALLOWLIST")?.start().await?;
    let root = s.sandbox.data.clone();
    let before = seed_unknown(&root)?;
    fs::create_dir_all(root.join("outputs"))?;
    fs::write(root.join("outputs/owned-proof"), b"owned")?;
    fs::create_dir_all(root.join("tasks"))?;
    fs::write(root.join("tasks/source"), b"owned task")?;
    // Wrong types are preserved and diagnosed; a named store link is moved as a link.
    fs::write(root.join("worktrees"), b"wrong type, keep")?;
    let outside = s.sandbox.workspace.join("outside");
    fs::create_dir_all(&outside)?;
    fs::write(outside.join("source"), b"outside target")?;
    let target_hash = Sha256::digest(fs::read(outside.join("source"))?);
    butler_platform::secure_fs::symlink(&outside, &root.join("unknown-link"))?;
    butler_platform::secure_fs::symlink(&outside, &root.join("downloads"))?;
    fs::create_dir_all(root.join("logs/user-directory"))?;
    fs::write(root.join("logs/user-directory/source"), b"wrong log type")?;
    reset_and_restart(&mut s).await?;
    assert_eq!(hashes(&root)?, before);
    assert!(!root.join("outputs/owned-proof").exists());
    assert!(!root.join("tasks/source").exists());
    assert_eq!(fs::read(root.join("worktrees"))?, b"wrong type, keep");
    assert!(s.agent.logs().contains("retained wrong type: worktrees"));
    assert_eq!(
        fs::read(root.join("logs/user-directory/source"))?,
        b"wrong log type"
    );
    assert!(
        fs::symlink_metadata(root.join("unknown-link"))?
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_link(root.join("unknown-link"))?, outside);
    assert!(fs::symlink_metadata(root.join("downloads")).is_err());
    assert_eq!(
        Sha256::digest(fs::read(outside.join("source"))?),
        target_hash
    );
    s.finish().await
}

#[tokio::test]
async fn existing_default_root_with_unknown_entries_migrates_without_overrides()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    default_root(false).await
}
#[tokio::test]
async fn explicit_default_root_with_unknown_entries_also_migrates() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    default_root(true).await
}
async fn default_root(explicit: bool) -> Result<(), HarnessError> {
    let mut setup = setup("RESET-DEFAULT-ALLOWLIST")?;
    setup.sandbox.data = setup.sandbox.home.join(".butler");
    if !explicit {
        setup = setup.unset_env("BUTLER_DATA");
    }
    let mut s = setup.start().await?;
    let root = s.sandbox.data.clone();
    s.agent.terminate().await?;
    fs::remove_file(root.join("state/data-root-owner.json"))?;
    let before = seed_unknown(&root)?;
    butler_platform::secure_fs::symlink(&s.sandbox.workspace, &root.join("unknown-link"))?;
    fs::create_dir_all(root.join("outputs"))?;
    fs::write(root.join("outputs/owned-proof"), b"owned")?;
    s.gw = s.agent.start_again().await?;
    assert!(root.join("state/data-root-owner.json").exists());
    reset_and_restart(&mut s).await?;
    assert_eq!(hashes(&root)?, before);
    assert!(!root.join("outputs/owned-proof").exists());
    assert_eq!(
        fs::read_link(root.join("unknown-link"))?,
        s.sandbox.workspace
    );
    s.finish().await
}

#[tokio::test]
async fn custom_unmarked_root_is_refused_without_changing_entries() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("RESET-CUSTOM-ALLOWLIST")?;
    let before = seed_unknown(&setup.sandbox.data)?;
    fs::create_dir_all(setup.sandbox.data.join("outputs"))?;
    fs::write(setup.sandbox.data.join("outputs/owned-proof"), b"owned")?;
    let s = setup.start().await?;
    let root = &s.sandbox.data;
    assert!(!root.join("state/data-root-owner.json").exists());
    let old = generation(&s).await?;
    let config = fs::read(root.join("butler.config.json"))?;
    let reply = request(&s, &nonce(&s).await?).await?;
    assert_eq!(reply.status, 409, "{}", reply.text);
    assert_eq!(reply.error_code(), Some("full_reset_unsafe_root"));
    assert_eq!(generation(&s).await?, old);
    assert_eq!(hashes(root)?, before);
    assert_eq!(fs::read(root.join("butler.config.json"))?, config);
    assert_eq!(fs::read(root.join("outputs/owned-proof"))?, b"owned");
    assert!(!root.join("state/full-reset.json").exists());
    s.finish().await
}

#[tokio::test]
async fn configured_symlink_to_default_root_does_not_grant_ownership() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = setup("RESET-DEFAULT-LINK")?;
    setup.sandbox.data = setup.sandbox.home.join(".butler");
    let mut s = setup.start().await?;
    s.agent.terminate().await?;
    let root = s.sandbox.data.clone();
    fs::remove_file(root.join("state/data-root-owner.json"))?;
    let before = seed_unknown(&root)?;
    let alias = s.sandbox.home.join("alias");
    butler_platform::secure_fs::symlink(&root, &alias)?;
    s.agent
        .launch
        .set_env("BUTLER_DATA", alias.display().to_string());
    s.gw = s.agent.start_again().await?;
    assert!(!root.join("state/data-root-owner.json").exists());
    let reply = request(&s, &nonce(&s).await?).await?;
    assert_eq!(reply.status, 409, "{}", reply.text);
    assert_eq!(reply.error_code(), Some("full_reset_unsafe_root"));
    assert_eq!(hashes(&root)?, before);
    s.finish().await
}

#[tokio::test]
async fn journal_rejects_moves_outside_shared_store_boundaries() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("RESET-JOURNAL-ALLOWLIST")?.start().await?;
    let before = seed_unknown(&s.sandbox.data)?;
    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    s.agent.kill9()?;
    let path = s.sandbox.data.join("state/full-reset.json");
    let mut journal: Value = serde_json::from_slice(&fs::read(&path)?)?;
    for invalid in [
        "user-folder",
        "cache/models",
        "app/runtime/user-entry",
        "logs",
    ] {
        journal["moves"] = json!([invalid]);
        let bytes = journal.to_string();
        fs::write(&path, &bytes)?;
        assert!(s.agent.start_again().await.is_err());
        assert_eq!(fs::read_to_string(&path)?, bytes);
        assert_eq!(hashes(&s.sandbox.data)?, before);
    }
    fs::remove_file(path)?;
    s.finish().await
}
