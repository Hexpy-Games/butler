//! Reader boundaries remain authoritative when post-run filesystem state changes.
use super::*;
use butler_turn::workspace::{PathForm, ReadFileInput, WorkspaceFiles};

fn bind_inventory(s: &Setup) -> std::sync::Arc<butler_platform::secure_fs::SecretInventory> {
    butler_platform::secure_fs::SecretInventory::for_environment(
        &s.sandbox.data,
        &HashMap::from([
            ("HOME".into(), s.sandbox.home.display().to_string()),
            ("BUTLER_DATA".into(), s.sandbox.data.display().to_string()),
        ]),
    )
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
    let inventory = bind_inventory(&s);
    assert!(
        butler_platform::secure_fs::open_contained(root, Path::new("host-hard"), &inventory)
            .is_err()
    );
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
    assert!(filtered.skipped_files.contains(&"site/alias".to_owned()));
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
async fn reader_accepts_public_hard_links_when_credential_identity_bound_is_exhausted()
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
    // Overflow is bounded defense in depth; unrelated package-store links
    // remain available. The earlier scenario asserts recorded credentials deny.
    assert_eq!(
        read(root, &s.sandbox.data, "public-hard").await["content"],
        "complete-public"
    );
    assert_eq!(
        read(root, &s.sandbox.data, "plain").await["content"],
        "complete-public"
    );
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn reader_supports_deep_absolute_links_and_recreated_symlink_root() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(butler_platform::secure_fs::FILE_IDS, "Unix descriptor walk");
    let mut s = Setup::new("CONTAINED-ROOT-LIFETIME")?;
    let root = &s.sandbox.workspace;
    let deep = PathBuf::from_iter(std::iter::repeat_n("d", 64)).join("file");
    std::fs::create_dir_all(root.join(&deep).parent().unwrap())?;
    std::fs::write(root.join(&deep), "complete-deep")?;
    butler_platform::secure_fs::symlink(&root.join(&deep), &root.join("compile_commands.json"))?;
    let alias = s.sandbox.home.join("chosen-project");
    butler_platform::secure_fs::symlink(root, &alias)?;
    for path in [deep.to_str().unwrap(), "compile_commands.json"] {
        assert_eq!(
            read(&alias, &s.sandbox.data, path).await["content"],
            "complete-deep"
        );
    }
    let inventory = butler_platform::secure_fs::SecretInventory::cached(&s.sandbox.data);
    let first = inventory.for_turn();
    let _pin = first.pin_root(root)?;
    let old = root.with_extension("old");
    std::fs::rename(root, &old)?;
    std::fs::create_dir(root)?;
    std::fs::write(root.join("new"), "complete-new")?;
    assert!(butler_platform::secure_fs::open_contained(root, Path::new("new"), &first).is_err());
    let second = inventory.for_turn();
    let _next = second.pin_root(root)?;
    let mut content = String::new();
    std::io::Read::read_to_string(
        &mut butler_platform::secure_fs::open_contained(root, Path::new("new"), &second)?,
        &mut content,
    )?;
    assert_eq!(content, "complete-new");
    assert!(butler_platform::secure_fs::open_contained(root, Path::new("new"), &first).is_err());
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn grep_and_edit_readback_refuse_credential_hard_link_content() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(butler_platform::secure_fs::FILE_IDS, "Unix hard links");
    let mut s = Setup::new("CONTAINED-READBACK")?;
    let root = &s.sandbox.workspace;
    std::fs::create_dir_all(s.sandbox.data.join("auth"))?;
    std::fs::write(s.sandbox.data.join("auth/login"), "private-fixture")?;
    std::fs::hard_link(s.sandbox.data.join("auth/login"), root.join("alias"))?;
    let owner = WorkspaceFiles::new(1).request();
    let result = owner
        .grep_candidate(butler_turn::workspace::GrepCandidate {
            butler_data: s.sandbox.data.clone(),
            root: root.clone(),
            path_form: PathForm::Contained,
            protected_roots: Vec::new(),
            path: "alias".into(),
            bytes: 15,
            matcher: std::sync::Arc::new(regress::Regex::new("private").unwrap()),
            context_lines: 0,
            max_bytes_per_file: 1024,
            max_matches: 10,
            max_output_bytes: 1024,
            after_line: None,
            deadline: std::time::Instant::now() + Duration::from_secs(60),
        })
        .await
        .unwrap();
    assert!(result.skipped);
    assert_eq!(result.reason, Some("sensitive_path_blocked"));
    assert!(result.matches.is_empty());
    let scope = butler_turn::workspace::EffectFileScope {
        inventory: None,
        workspace: root.clone(),
        butler_data: s.sandbox.data.clone(),
        protected_roots: Vec::new(),
        installation_root: None,
        contained: true,
    };
    assert!(
        butler_turn::workspace::read_effect_edit_target(&scope, "alias")
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(s.sandbox.data.join("auth/login"))?,
        "private-fixture"
    );
    owner.close().await;
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn reader_refreshes_new_credential_root_and_separates_environments()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(butler_platform::secure_fs::FILE_IDS, "Unix identities");
    let mut s = Setup::new("CONTAINED-NEW-ROOT")?;
    let root = &s.sandbox.workspace;
    let inventory = bind_inventory(&s);
    let alternate = butler_platform::secure_fs::SecretInventory::for_environment(
        &s.sandbox.data,
        &HashMap::new(),
    );
    assert!(!std::sync::Arc::ptr_eq(&inventory, &alternate));
    let home_store = s.sandbox.home.join(".config/gcloud");
    std::fs::create_dir_all(home_store.parent().unwrap())?;
    butler_platform::secure_fs::symlink(&root.join("new-store"), &home_store)?;
    inventory.refresh();
    std::fs::create_dir(root.join("new-store"))?;
    std::fs::write(root.join("new-store/login"), "private-fixture")?;
    assert!(
        butler_platform::secure_fs::open_contained(root, Path::new("new-store/login"), &inventory)
            .is_err()
    );
    s.sandbox.mark_success();
    Ok(())
}
