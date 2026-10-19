//! Reader boundaries remain authoritative when post-run filesystem state changes.
use super::*;
use butler_turn::workspace::{PathForm, ReadFileInput, WorkspaceFiles};

fn bind_inventory(s: &Setup) {
    butler_platform::secure_fs::SecretInventory::for_environment(
        &s.sandbox.data,
        &HashMap::from([
            ("HOME".into(), s.sandbox.home.display().to_string()),
            ("BUTLER_DATA".into(), s.sandbox.data.display().to_string()),
        ]),
    );
}

pub(super) async fn read(root: &Path, data: &Path, path: &str) -> Value {
    let owner = WorkspaceFiles::new(1);
    let result = owner
        .read_one(ReadFileInput {
            butler_data: data.to_path_buf(),
            root: root.to_path_buf(),
            path: path.into(),
            path_form: PathForm::Contained,
            protected_roots: Vec::new(),
            start_line: None,
            limit_lines: None,
            max_bytes: 262_144,
            offset_bytes: None,
        })
        .await
        .unwrap()
        .unwrap()
        .result;
    owner.close().await;
    result
}
async fn denied(s: &Setup, path: &str) {
    let result = read(&s.sandbox.workspace, &s.sandbox.data, path).await;
    assert_eq!(result["ok"], false, "reader must refuse {path}");
    assert!(result.get("content").is_none());
}

#[tokio::test]
async fn reader_refuses_created_scratch_dangling_and_hard_links() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::secure_fs::FILE_IDS,
        "Unix contained readers"
    );
    let mut s = Setup::new("LINUX-CONTAINED-LINKS")?;
    bind_inventory(&s);
    let root = &s.sandbox.workspace;
    let auth = s.sandbox.data.join("auth");
    let scratch = s.sandbox.data.join("tmp/project-write");
    for path in [&auth, &scratch] {
        std::fs::create_dir_all(path)?;
    }
    std::fs::write(root.join("public-source"), "complete-public")?;
    std::fs::hard_link(root.join("public-source"), root.join("public-hard"))?;
    assert_eq!(
        read(root, &s.sandbox.data, "public-hard").await["content"],
        "complete-public"
    );
    let credential = auth.join("login");
    std::fs::write(&credential, "private-fixture")?;
    // Run-created links remain dangerous even when no cleanup has run.
    butler_platform::secure_fs::symlink(&credential, &root.join("created"))?;
    butler_platform::secure_fs::symlink(&scratch, &root.join("scratch"))?;
    butler_platform::secure_fs::symlink(&credential, &scratch.join("nested"))?;
    butler_platform::secure_fs::symlink(&auth.join("later"), &root.join("dangling"))?;
    for path in ["created", "scratch/nested", "dangling"] {
        denied(&s, path).await;
    }
    std::fs::write(auth.join("later"), "private-fixture")?;
    denied(&s, "dangling").await;
    std::fs::hard_link(&credential, root.join("hard"))?;
    denied(&s, "hard").await;
    std::fs::create_dir_all(s.sandbox.home.join(".ssh"))?;
    let key = s.sandbox.home.join(".ssh/id_ed25519");
    std::fs::write(&key, "private-fixture")?;
    std::fs::hard_link(key, root.join("host-hard"))?;
    denied(&s, "host-hard").await;
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn reader_refuses_old_links_retargeted_by_link_swap_and_directory_move()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::secure_fs::FILE_IDS,
        "Unix contained readers"
    );
    let mut s = Setup::new("LINUX-CONTAINED-RETARGET")?;
    bind_inventory(&s);
    let root = &s.sandbox.workspace;
    std::fs::create_dir_all(root.join("m"))?;
    std::fs::write(root.join("ordinary"), "complete-public")?;
    let outside = root.parent().unwrap().join("ordinary");
    std::fs::write(&outside, "private-fixture")?;
    butler_platform::secure_fs::symlink(Path::new("m/../ordinary"), &root.join("old"))?;
    assert_eq!(
        read(root, &s.sandbox.data, "old").await["content"],
        "complete-public"
    );
    std::fs::remove_dir(root.join("m"))?;
    butler_platform::secure_fs::symlink(&s.sandbox.data, &root.join("m"))?;
    assert_eq!(root.join("old").canonicalize()?, outside);
    denied(&s, "old").await;
    std::fs::create_dir_all(root.join("a/b/pkg"))?;
    butler_platform::secure_fs::symlink(Path::new("../.."), &root.join("a/b/pkg/r"))?;
    std::fs::write(root.join("a/ordinary"), "complete-public")?;
    assert_eq!(
        read(root, &s.sandbox.data, "a/b/pkg/r/ordinary").await["content"],
        "complete-public"
    );
    std::fs::rename(root.join("a/b/pkg"), root.join("pkg"))?;
    assert_eq!(root.join("pkg/r/ordinary").canonicalize()?, outside);
    denied(&s, "pkg/r/ordinary").await;
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn reader_accepts_relative_project_and_pnpm_style_link_farms() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::secure_fs::FILE_IDS,
        "Unix contained readers"
    );
    let mut s = Setup::new("LINUX-CONTAINED-POSITIVE")?;
    bind_inventory(&s);
    let root = &s.sandbox.workspace;
    std::fs::create_dir_all(root.join("node_modules/.pnpm/pkg/node_modules/pkg"))?;
    std::fs::write(root.join("package-store"), "complete-public")?;
    std::fs::hard_link(
        root.join("package-store"),
        root.join("node_modules/.pnpm/pkg/node_modules/pkg/index.js"),
    )?;
    std::fs::write(root.join("plain"), "complete-public")?;
    butler_platform::secure_fs::symlink(Path::new("plain"), &root.join("relative"))?;
    butler_platform::secure_fs::symlink(
        Path::new(".pnpm/pkg/node_modules/pkg"),
        &root.join("node_modules/pkg"),
    )?;
    for path in ["plain", "relative", "node_modules/pkg/index.js"] {
        let result = read(root, &s.sandbox.data, path).await;
        assert_eq!(result["ok"], true);
        assert_eq!(result["content"], "complete-public");
        assert_eq!(result["bytes"], 15);
    }
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn output_folder_skips_private_names_and_refuses_credential_hard_links()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::secure_fs::FILE_IDS,
        "Unix credential file identities"
    );
    let mut s = Setup::new("OUTPUT-CONTAINED-SECRETS")?;
    bind_inventory(&s);
    let root = &s.sandbox.workspace;
    std::fs::create_dir_all(root.join("site/.git"))?;
    for (path, text) in [
        ("site/index.html", "complete-public"),
        ("site/.env", "private-fixture"),
        ("site/.git/config", "private-fixture"),
    ] {
        std::fs::write(root.join(path), text)?;
    }
    let store = butler_runtime::outputs::OutputStore::new(&s.sandbox.data);
    let request = || butler_runtime::outputs::PublishRequest {
        workspace: root.clone(),
        path: "site".into(),
        entry: None,
        title: "Site".into(),
        session_id: "session".into(),
        message_id: "message".into(),
        turn_id: "turn".into(),
    };
    let (output, _) = store.publish(request())?;
    assert_eq!(
        output.revisions[0]
            .files
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ["index.html"]
    );
    let mut bytes = String::new();
    use std::io::Read;
    store
        .open_content(&output.output_id, 1, "index.html")?
        .read_to_string(&mut bytes)?;
    assert_eq!(bytes, "complete-public");
    std::fs::create_dir_all(s.sandbox.data.join("auth"))?;
    std::fs::write(s.sandbox.data.join("auth/login"), "private-fixture")?;
    std::fs::hard_link(s.sandbox.data.join("auth/login"), root.join("site/alias"))?;
    let (filtered, _) = store.publish(request())?;
    assert_eq!(
        filtered
            .revisions
            .last()
            .unwrap()
            .files
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ["index.html"]
    );
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn reader_refuses_hard_links_when_credential_identity_bound_is_exhausted()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::secure_fs::FILE_IDS,
        "Unix credential identity bound"
    );
    let mut s = Setup::new("LINUX-CONTAINED-HARD-LIMIT")?;
    bind_inventory(&s);
    let root = &s.sandbox.workspace;
    let auth = s.sandbox.data.join("auth");
    std::fs::create_dir_all(&auth)?;
    for index in 0..5000 {
        std::fs::write(auth.join(format!("entry-{index}")), "private-fixture")?;
    }
    std::fs::write(root.join("plain"), "complete-public")?;
    std::fs::write(root.join("public-source"), "complete-public")?;
    std::fs::hard_link(root.join("public-source"), root.join("public-hard"))?;
    std::fs::hard_link(auth.join("entry-4999"), root.join("credential-hard"))?;
    denied(&s, "credential-hard").await;
    denied(&s, "public-hard").await;
    assert_eq!(
        read(root, &s.sandbox.data, "plain").await["content"],
        "complete-public"
    );
    s.sandbox.mark_success();
    Ok(())
}
