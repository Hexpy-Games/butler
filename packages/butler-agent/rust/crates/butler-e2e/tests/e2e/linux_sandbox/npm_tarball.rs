//! Offline archive extraction exercises npm's chmod path, unlike file: links.
use super::*;
use butler_e2e::e2e::scenario::Scenario;

const MANIFEST: &str = r#"{"name":"archive-cli","version":"1.0.0","bin":{"archive-cli":"cli.js"},"files":["cli.js","payload.txt"]}"#;
const BIN: &str = "#!/usr/bin/env node\nconsole.log('archive-bin-complete');\n";
const PAYLOAD: &str = "complete archive payload\n";

#[tokio::test]
async fn offline_tarball_install_native_tier() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux npm archive");
    install(false).await
}

#[tokio::test]
async fn offline_tarball_install_tier_l() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux npm archive");
    install(true).await
}

async fn install(force_l: bool) -> Result<(), HarnessError> {
    let started = std::time::Instant::now();
    let (url, script, server) = stub::start().await?;
    let mut setup = test_support_agent(Setup::mutates_installation("LINUX-NPM-TARBALL")?)?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    if force_l {
        setup = setup.env("BUTLER_TEST_SANDBOX_FORCE_L", "1");
    }
    let folder = setup.sandbox.home.join("project");
    std::fs::create_dir_all(&folder)?;
    let mut s = setup.start().await?;
    let chat = super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let root = folder.join("작업 Project");
    let command = fixture(&root, &s)?;
    let tier = tier(&root, force_l)?;
    let prompt = "Install the offline archive and run its executable.";
    script.rounds.lock().unwrap().insert(
        prompt.into(),
        vec![stub::call(
            "install",
            "run_command",
            &json!({"command":command,
            "summary":"Install archive", "state_effect":"mutation"}),
        )],
    );
    let id = s.gw.say_turn(&chat, prompt).await?;
    super::super::access_tiers::delivered(&s, &chat, &id).await?;
    super::super::access_tiers::assert_counts(&s, &id, 0, 0)?;
    let outputs = super::super::access_tiers::outputs(&s, &chat, &id, &script, prompt).await?;
    assert_eq!(outputs.len(), 1);
    let value: Value = serde_json::from_str(&outputs[0])?;
    let body = value
        .get("output")
        .filter(|v| v.is_object())
        .unwrap_or(&value);
    assert_result(body, tier, &root)?;
    assert_eq!(
        std::fs::read_to_string(folder.join("outside"))?,
        "outside\n"
    );
    assert!(!folder.join("escaped").exists());
    assert_eq!(std::fs::read_to_string(root.join("package.json"))?, "{}\n");
    assert_eq!(std::fs::read_to_string(root.join("source/cli.js"))?, BIN);
    assert!(!root.join("package-lock.json").exists());
    eprintln!(
        "npm tarball tier={tier} duration={:?}: {body}",
        started.elapsed()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn tier(root: &Path, force_l: bool) -> Result<&'static str, HarnessError> {
    let policy =
        command_sandbox::project_write_shell("true", &HashMap::new(), root, &[], &[], None)
            .unwrap();
    let policy: Value = serde_json::from_str(&policy.arguments[1])?;
    Ok(if force_l || policy["mountns"] != true {
        "L"
    } else if policy["mountns_plus"] == true {
        "M+"
    } else {
        "M"
    })
}

fn fixture(root: &Path, s: &Scenario) -> Result<String, HarnessError> {
    let source = root.join("source");
    std::fs::create_dir(&source)?;
    std::fs::write(source.join("package.json"), MANIFEST)?;
    std::fs::write(source.join("cli.js"), BIN)?;
    std::fs::write(source.join("payload.txt"), PAYLOAD)?;
    std::fs::write(root.join("package.json"), "{}\n")?;
    std::fs::write(root.join(".gitignore"), "node_modules\n")?;
    std::fs::write(root.parent().unwrap().join("outside"), "outside\n")?;
    let cache = s.sandbox.data.join("tmp/project-write/npm-cache");
    let packed = Command::new("npm")
        .args(["pack", "--offline", "--ignore-scripts", "--json", "--cache"])
        .arg(s.sandbox.home.join("pack-cache"))
        .current_dir(&source)
        .env("HOME", &s.sandbox.home)
        .output()?;
    assert!(packed.status.success(), "npm pack: {packed:?}");
    let manifest: Value = serde_json::from_slice(&packed.stdout)?;
    let archive = source.join(manifest[0]["filename"].as_str().unwrap());
    std::fs::rename(archive, root.join("archive.tgz"))?;
    // Explicitly probe writes outside the project before installing; they must
    // fail on every tier and must not hide npm's exit status.
    std::fs::write(
        root.join("install.sh"),
        format!(
            "(echo escaped > ../outside) 2>/dev/null; \
         (echo escaped > ../escaped) 2>/dev/null; \
         npm install ./archive.tgz --offline --ignore-scripts --no-audit --no-fund \
         --no-save --package-lock=false --cache '{}' && node_modules/.bin/archive-cli",
            cache.display()
        ),
    )?;
    Ok("sh install.sh".into())
}

fn assert_result(body: &Value, tier: &str, root: &Path) -> Result<(), HarnessError> {
    assert_eq!(body["sandbox"], "project_write_contained", "{body}");
    assert_eq!(body["timed_out"], false, "{body}");
    if tier == "M+" {
        assert_eq!(body["ok"], true, "{body}");
        assert_eq!(body["exit_code"], 0, "{body}");
        assert_package(root)?;
        let stdout = body["stdout"].as_str().unwrap();
        assert!(stdout.contains("added 1 package"), "{body}");
        assert!(stdout.ends_with("archive-bin-complete\n"), "{body}");
        eprintln!(
            "npm tarball tier=M+: complete package, executable .bin, bin output=archive-bin-complete"
        );
    } else {
        assert_eq!(body["ok"], false, "{body}");
        assert_ne!(
            body["exit_code"].as_i64().expect("command exited"),
            0,
            "{body}"
        );
        let hint = if tier == "L" {
            "This command ran contained to the project folder: no writes elsewhere (including .git and existing secrets) and no network. Creating, deleting or renaming top-level project entries is also blocked. If it needs those, run it again with sandbox \"none\"; the user will be asked."
        } else {
            "This command ran contained to the project folder: no writes elsewhere, no network, and existing secrets are masked. New secret names are swept after the run. Metadata changes are blocked. If it needs more access, run it again with sandbox \"none\"; the user will be asked."
        };
        assert_eq!(body["next_action"], hint, "{body}");
        assert!(
            !body["stdout"]
                .as_str()
                .unwrap()
                .contains("archive-bin-complete")
        );
        eprintln!("npm tarball tier={tier}: contained failure; approval retry hint={hint}");
    }
    Ok(())
}

fn assert_package(root: &Path) -> Result<(), HarnessError> {
    let package = root.join("node_modules/archive-cli");
    assert!(package.is_dir());
    assert!(
        !std::fs::symlink_metadata(&package)?
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        std::fs::read_to_string(package.join("package.json"))?,
        MANIFEST
    );
    assert_eq!(std::fs::read_to_string(package.join("cli.js"))?, BIN);
    assert_eq!(
        std::fs::read_to_string(package.join("payload.txt"))?,
        PAYLOAD
    );
    let bin = root.join("node_modules/.bin/archive-cli");
    assert!(std::fs::symlink_metadata(&bin)?.file_type().is_symlink());
    assert_eq!(bin.canonicalize()?, package.join("cli.js").canonicalize()?);
    assert!(
        butler_platform::secure_fs::file_mode(&std::fs::metadata(&bin)?)
            .unwrap()
            .is_executable()
    );
    Ok(())
}
