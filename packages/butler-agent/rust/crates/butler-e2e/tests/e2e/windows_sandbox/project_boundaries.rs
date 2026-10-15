use super::*;

#[test]
fn row01_project_and_scratch() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-01")?;
    f.pass("$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('made.txt','complete'); if ([IO.File]::ReadAllText('made.txt') -ne 'complete') {exit 1}; [IO.File]::WriteAllText(($env:TEMP+'\\scratch.txt'),'scratch'); if ([IO.File]::ReadAllText(($env:TEMP+'\\scratch.txt')) -ne 'scratch') {exit 2}");
    assert_eq!(std::fs::read(f.root.join("made.txt"))?, b"complete");
    for dir in &f.scratch[1..] {
        f.pass(&format!("$ErrorActionPreference='Stop'; [IO.File]::WriteAllText({},'complete'); if ([IO.File]::ReadAllText({}) -ne 'complete') {{exit 1}}",quote(&dir.join("made.txt")),quote(&dir.join("made.txt"))));
    }
    f.finish();
    Ok(())
}

#[test]
fn row02_outside_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-02")?;
    let sibling = f.setup.sandbox.home.join("sibling");
    std::fs::create_dir(&sibling)?;
    for path in [
        sibling.join("escape"),
        f.root.parent().unwrap().join("escape"),
        f.setup.sandbox.home.join("escape"),
        f.setup.sandbox.data.join("escape"),
    ] {
        f.deny(&format!(
            "$ErrorActionPreference='Stop'; [IO.File]::WriteAllText({},'escape')",
            quote(&path)
        ));
        assert!(!path.exists());
    }
    // An alternate spelling through the existing system drive is denied too;
    // enumerate actual fixed drives rather than creating or changing mappings.
    let output =
        f.pass("[Environment]::GetLogicalDrives() | ForEach-Object { [Console]::WriteLine($_) }");
    for drive in String::from_utf8_lossy(&output.stdout).lines() {
        f.deny(&format!("$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('{}Butler-sandbox-outside-{}.tmp','escape')",drive,f.setup.sandbox.root.file_name().unwrap().to_string_lossy()));
    }
    f.finish();
    Ok(())
}

#[test]
fn row03_secret_contents_ads_and_parent_delete() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-03")?;
    std::fs::create_dir_all(f.root.join("sub"))?;
    std::fs::create_dir(f.root.join(".git"))?;
    std::fs::write(f.root.join(".git/config"), "protected")?;
    for name in [".env", "sub/.env.local", "id_rsa", "key.pem"] {
        let path = f.root.join(name);
        std::fs::write(&path, "fixture-secret")?;
        for script in [
            format!("[IO.File]::ReadAllText({})", quote(&path)),
            format!("[IO.File]::WriteAllText({},'escape')", quote(&path)),
            format!(
                "[IO.File]::WriteAllText({} + ':ads','escape')",
                quote(&path)
            ),
        ] {
            let output = f.deny(&format!("$ErrorActionPreference='Stop'; {script}"));
            assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-secret"));
        }
        assert_eq!(std::fs::read(&path)?, b"fixture-secret");
    }
    for name in [".env", ".git"] {
        f.deny(&format!(
            "$ErrorActionPreference='Stop'; Remove-Item -LiteralPath '{name}' -Recurse -Force"
        ));
        f.deny(&format!(
            "$ErrorActionPreference='Stop'; Rename-Item -LiteralPath '{name}' -NewName 'escaped'"
        ));
        assert!(f.root.join(name).exists());
    }
    f.finish();
    Ok(())
}

#[test]
fn row08_ancestor_sibling_listings() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-08")?;
    for path in [
        f.root.parent().unwrap(),
        &f.setup.sandbox.data,
        &f.setup.sandbox.workspace,
    ] {
        f.deny(&format!(
            "$ErrorActionPreference='Stop'; [IO.Directory]::GetFileSystemEntries({})",
            quote(path)
        ));
    }
    f.finish();
    Ok(())
}
