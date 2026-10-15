//! A WSL project on a Windows drive (drvfs). Opt-in: the owner names a
//! writable Windows folder; hosted Linux runners have no Windows drive.
use super::*;

struct Removed(PathBuf);
impl Drop for Removed {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn project_on_wsl_windows_drive() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let drive = std::env::var_os("BUTLER_E2E_WSL_DRIVE_DIR").map(PathBuf::from);
    butler_e2e::skip_unless!(
        command_sandbox::linux_test_host() && drive.as_ref().is_some_and(|dir| dir.is_dir()),
        "BUTLER_E2E_WSL_DRIVE_DIR names no Windows drive folder"
    );
    let mut setup = Setup::new("LINUX-WSL-DRIVE")?;
    std::fs::create_dir_all(setup.sandbox.data.join("tmp/project-write"))?;
    let root = Removed(
        drive
            .unwrap()
            .join(format!("butler-{}", uuid::Uuid::new_v4())),
    );
    let root = &root.0;
    for dir in ["config", ".git", "src"] {
        std::fs::create_dir_all(root.join(dir))?;
    }
    for name in [".env", "config/.env", ".git/config"] {
        std::fs::write(root.join(name), "protected")?;
    }
    std::fs::write(root.join("package.json"), "original")?;
    std::fs::write(root.join("src/main.rs"), "fn main() {}\n")?;
    std::fs::write(
        root.join("Cargo.toml"),
        "[package]\nname=\"minimal\"\nversion=\"0.1.0\"\nedition=\"2024\"\n",
    )?;
    let scratch = setup.sandbox.data.join("tmp/project-write");
    let invoke = |command: &str| {
        command_sandbox::project_write_shell(
            command,
            &HashMap::from([("HOME".into(), setup.sandbox.home.display().to_string())]),
            root,
            &[&scratch],
            &[&setup.sandbox.data],
        )
        .unwrap()
    };
    let policy: Value = serde_json::from_str(&invoke("true").arguments[1])?;
    let (mounted, plus) = (policy["mountns"] == true, policy["mountns_plus"] == true);
    eprintln!("WSL drive tier: mounted={mounted} plus={plus}");
    for command in ["cat .env", "cat config/.env", "cat .git/config"] {
        let output = run(invoke(command), root, &setup.sandbox.home);
        assert!(output.stdout.is_empty(), "{command}: {output:?}");
    }
    for command in ["rm .env", "mv config moved", "rm -rf .git"] {
        let output = run(invoke(command), root, &setup.sandbox.home);
        assert!(!output.status.success(), "{command}: {output:?}");
    }
    // Tier M grants the project root; drvfs then behaves like a Linux disk.
    let build = format!(
        "sed -i s/original/changed/ package.json && echo new > NEW && chmod +x NEW && \
         env -u CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER \
         -u CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS TMPDIR='{}' RUSTC_WRAPPER= \
         CARGO_TARGET_DIR=target cargo build --offline -j 1",
        scratch.display()
    );
    let output = run(invoke(&build), root, &setup.sandbox.home);
    assert_eq!(output.status.success(), plus, "{output:?}");
    if plus {
        assert_eq!(
            std::fs::read_to_string(root.join("package.json"))?,
            "changed"
        );
        assert!(root.join("target/debug/minimal").exists());
    }
    for name in [".env", "config/.env", ".git/config"] {
        assert_eq!(std::fs::read_to_string(root.join(name))?, "protected");
    }
    setup.sandbox.mark_success();
    Ok(())
}
