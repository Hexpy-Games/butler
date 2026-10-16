use super::*;

#[test]
fn row04_git() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-04")?;
    std::fs::write(f.root.join("tracked.txt"), "original\n")?;
    for args in [
        vec!["init", "-q"],
        vec!["add", "tracked.txt"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "fixture",
        ],
    ] {
        let output = Command::new("git.exe")
            .args(args)
            .envs(&f.env)
            .current_dir(&f.root)
            .output()?;
        assert!(output.status.success(), "{output:?}");
    }
    let config = std::fs::read(f.root.join(".git/config"))?;
    setup_complete!(f);
    for script in [
        "cmd /c git status --porcelain",
        "cmd /c git diff",
        "cmd /c git log -1 --format=%s",
        "cmd /c git show HEAD:tracked.txt",
    ] {
        f.pass(script);
    }
    assert!(
        String::from_utf8_lossy(&f.pass("cmd /c git show HEAD:tracked.txt").stdout)
            .contains("original")
    );
    std::fs::write(f.root.join("tracked.txt"), "changed\n")?;
    for script in [
        "cmd /c git add tracked.txt",
        "cmd /c git commit -am denied",
        "$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('.git/config','escape')",
    ] {
        f.deny(script);
    }
    assert_eq!(std::fs::read(f.root.join(".git/config"))?, config);
    f.finish();
    Ok(())
}

#[test]
fn row10_toolchains_unicode_long_path() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let mut f = Fixture::new("WIN-10")?;
    let length = f.root.to_string_lossy().encode_utf16().count();
    assert!(length < 229, "fixture root leaves no room for a long grant");
    f.root = f.root.join("l".repeat(229 - length));
    std::fs::create_dir_all(&f.root)?;
    std::fs::create_dir(f.root.join("src"))?;
    std::fs::write(
        f.root.join("src/main.rs"),
        "fn main() { println!(\"complete\"); }\n",
    )?;
    std::fs::write(
        f.root.join("Cargo.toml"),
        "[package]\nname='fixture'\nversion='0.1.0'\nedition='2024'\n",
    )?;
    setup_complete!(f);
    let out = f.pass("$env:CARGO_TARGET_DIR='target'; cargo build --offline; if ($LASTEXITCODE) {exit $LASTEXITCODE}; & .\\target\\debug\\fixture.exe; exit $LASTEXITCODE");
    assert!(String::from_utf8_lossy(&out.stdout).contains("complete"));
    // The owner build cache must already contain this exact workspace version;
    // the test never downloads dependencies or installs a toolchain.
    std::fs::write(
        f.root.join("Cargo.toml"),
        "[package]\nname='fixture'\nversion='0.1.0'\nedition='2024'\n[dependencies]\nserde='=1.0.229'\n",
    )?;
    f.pass("$env:CARGO_TARGET_DIR='target'; cargo build --offline; exit $LASTEXITCODE");
    let rust = f.pass("cmd /c rustc --version");
    assert!(String::from_utf8_lossy(&rust.stdout).starts_with("rustc "));
    let node = f.pass("node -e \"process.stdout.write('complete')\"; exit $LASTEXITCODE");
    assert_eq!(node.stdout, b"complete");
    std::fs::write(f.root.join("package.json"), r#"{"name":"fixture"}"#)?;
    let npm = f.pass("npm --offline pkg get name; exit $LASTEXITCODE");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&npm.stdout)?,
        "fixture"
    );
    // The grant target remains within subst's documented 240 UTF-16 units;
    // a child path crosses MAX_PATH and is accessed via the short drive alias.
    let child = format!("{}\\{}\\파일.txt", "a".repeat(110), "b".repeat(110));
    f.pass(&format!("$ErrorActionPreference='Stop'; $p=[IO.Path]::GetFullPath('{child}'); [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)) | Out-Null; [IO.File]::WriteAllText($p,'complete'); if ([IO.File]::ReadAllText($p) -ne 'complete') {{exit 1}}"));
    f.finish();
    Ok(())
}
