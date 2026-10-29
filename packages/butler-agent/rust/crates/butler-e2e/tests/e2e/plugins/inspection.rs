use super::*;
use std::time::{Duration, Instant};

fn minimal_package(home: &Path) -> Result<PathBuf, HarnessError> {
    let root = home.join("package");
    fs::create_dir_all(&root)?;
    fs::write(
        root.join("plugin.json"),
        json!({"name":"helper","version":"1.2.3"}).to_string(),
    )?;
    Ok(root)
}
async fn refused(s: &Scenario, root: &Path, code: &str) -> Result<(), HarnessError> {
    let reply = api(
        s,
        Method::POST,
        "/plugins/inspect",
        Some(json!({"path":root})),
    )
    .await?;
    assert_eq!(reply.status, 400, "{reply:?}");
    assert!(reply.text.contains(code), "{reply:?}");
    super::security::assert_empty(s, "staging")?;
    Ok(())
}

#[tokio::test]
async fn case_collisions_are_refused_when_filesystem_supports_distinct_names()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG-CASE")?;
    let root = minimal_package(&setup.sandbox.home)?;
    fs::write(root.join("A.txt"), "upper")?;
    match fs::File::create_new(root.join("a.txt")) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            eprintln!("SKIPPED case collision: filesystem treats A.txt and a.txt as one path");
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    }
    let s = setup.start().await?;
    refused(&s, &root, "plugin_case_collision").await?;
    s.finish().await
}

#[tokio::test]
async fn file_count_limit_is_refused_before_staging() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG-FILE-LIMIT")?;
    let root = setup.sandbox.home.join("many-files");
    fs::create_dir(&root)?;
    for n in 0..50_001 {
        fs::File::create(root.join(format!("{n}.txt")))?;
    }
    let s = setup.start().await?;
    let started = Instant::now();
    refused(&s, &root, "plugin_too_large").await?;
    assert!(
        !s.sandbox.data.join("plugins/staging").exists(),
        "refusal must precede staging creation"
    );
    let elapsed = started.elapsed();
    eprintln!("50,001 files refused before staging: {elapsed:?}");
    butler_e2e::assert_wall_clock_budget!(elapsed, Duration::from_secs(10), "50,001 files refused");
    s.finish().await
}

#[tokio::test]
async fn sparse_file_over_one_gib_is_refused_before_staging() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG-BYTE-LIMIT")?;
    let root = setup.sandbox.home.join("large-file");
    fs::create_dir(&root)?;
    fs::File::create(root.join("large.bin"))?.set_len((1 << 30) + 1)?;
    let s = setup.start().await?;
    let started = Instant::now();
    refused(&s, &root, "plugin_too_large").await?;
    assert!(
        !s.sandbox.data.join("plugins/staging").exists(),
        "refusal must precede staging creation"
    );
    let elapsed = started.elapsed();
    eprintln!("1 GiB + 1 byte refused before staging: {elapsed:?}");
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_secs(1),
        "sparse file refused before copy"
    );
    s.finish().await
}

#[tokio::test]
async fn runtime_downloads_require_pins_and_are_disclosed_without_running()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG-RUNTIME-PINS")?;
    let root = minimal_package(&setup.sandbox.home)?;
    let s = setup.start().await?;
    for (command, args, pinned) in [
        ("npx", vec!["-y", "some-mcp"], false),
        ("uvx", vec!["some-mcp"], false),
        ("npx", vec!["some-mcp@latest"], false),
        ("npx", vec!["some-mcp@^1.2.3"], false),
        ("npx", vec!["--package=loose", "some-mcp@1.2.3"], false),
        ("npx", vec!["-y", "some-mcp@1.2.3"], true),
        ("npx", vec!["-y", "@scope/some-mcp@1.2.3"], true),
        ("uvx", vec!["--from", "some-mcp==1.2.3", "some-mcp"], true),
        ("uvx", vec!["some-mcp@1.2.3"], true),
    ] {
        fs::write(
            root.join("mcp.json"),
            json!({"mcpServers":{"notes":{"command":command,"args":args}}}).to_string(),
        )?;
        if pinned {
            let i = inspect(&s, &root).await?;
            assert_eq!(
                i["capabilities"]["runs_on_this_computer"],
                json!([{
                    "argv": std::iter::once(command).chain(args.iter().copied()).collect::<Vec<_>>(),
                    "downloads_code_at_runtime":true
                }])
            );
        } else {
            refused(&s, &root, "plugin_runtime_package_unpinned").await?;
        }
    }
    assert_eq!(
        api(&s, Method::GET, "/plugins", None).await?.data()["plugins"],
        json!([])
    );
    assert_eq!(s.gw.get("/mcp-servers").await?.data()["servers"], json!([]));
    super::security::assert_empty(&s, "store")?;
    s.finish().await
}

#[tokio::test]
async fn digest_tracks_paths_contents_and_executable_status_with_normalized_modes()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG-DIGEST")?;
    let root = minimal_package(&setup.sandbox.home)?;
    let file = root.join("a.txt");
    fs::write(&file, "first")?;
    fs::write(root.join("b.txt"), "second")?;
    let s = setup.start().await?;
    let first = inspect(&s, &root).await?["digest"].clone();
    assert_eq!(first, expected_digest(&root, "644")?);
    assert_eq!(first, inspect(&s, &root).await?["digest"]);
    fs::create_dir(root.join(".git"))?;
    fs::write(root.join(".git/config"), "ignored")?;
    assert_eq!(first, inspect(&s, &root).await?["digest"]);
    fs::write(&file, "changed")?;
    assert_ne!(first, inspect(&s, &root).await?["digest"]);
    fs::write(&file, "first")?;
    assert_eq!(first, inspect(&s, &root).await?["digest"]);
    fs::rename(&file, root.join("c.txt"))?;
    assert_ne!(first, inspect(&s, &root).await?["digest"]);
    fs::rename(root.join("c.txt"), &file)?;
    if butler_platform::secure_fs::PERMISSION_MODES {
        use butler_platform::secure_fs::{FileMode, set_file_mode};
        for mode in [
            FileMode::OWNER_ONLY,
            FileMode::GROUP_READABLE,
            FileMode::ORDINARY,
        ] {
            set_file_mode(&file, mode).unwrap()?;
            assert_eq!(first, inspect(&s, &root).await?["digest"]);
        }
        let mut executable = Value::Null;
        for mode in [FileMode::EXECUTABLE, FileMode::READ_ONLY_DIRECTORY] {
            set_file_mode(&file, mode).unwrap()?;
            let digest = inspect(&s, &root).await?["digest"].clone();
            assert_ne!(first, digest);
            assert_eq!(digest, expected_digest(&root, "755")?);
            if !executable.is_null() {
                assert_eq!(executable, digest);
            }
            executable = digest;
        }
    }
    s.finish().await
}

#[tokio::test]
async fn capabilities_are_deterministic_and_cannot_underdeclare() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG-CAPABILITIES")?;
    let root = minimal_package(&setup.sandbox.home)?;
    fs::write(root.join("plugin.json"), json!({"name":"helper","version":"1.2.3",
        "extensions":{"io.github.hexpy-games.butler":{"api":1,"capabilities":{"network":["https://example.com/other"]}}}}).to_string())?;
    fs::write(root.join("mcp.json"), json!({"mcpServers":{"remote":{
        "transport":"sse","url":"https://example.com/path","headers":{"Authorization":"${TOKEN}"}}}}).to_string())?;
    let s = setup.start().await?;
    let caps = inspect(&s, &root).await?["capabilities"].clone();
    assert_eq!(caps["network"], json!(["https://example.com"]));
    assert_eq!(caps["agent_tools"], json!(["helper/remote"]));
    assert_eq!(caps["secrets"], json!([{"key":"TOKEN","label":"TOKEN"}]));
    assert_eq!(caps, inspect(&s, &root).await?["capabilities"]);
    s.finish().await
}

fn expected_digest(root: &Path, file_mode: &str) -> Result<String, HarnessError> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for (path, mode) in [
        ("a.txt", file_mode),
        ("b.txt", "644"),
        ("plugin.json", "644"),
    ] {
        let content_hash = format!("{:x}", Sha256::digest(fs::read(root.join(path))?));
        hash.update(format!("{path}\0{mode}\0{content_hash}\n").as_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}
