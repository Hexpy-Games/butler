//! Unresolvable entries never change the classification of unrelated links.
use super::*;

#[tokio::test]
async fn unresolvable_inventory_preserves_unrelated_links() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux secret inventory");
    let mut s = Setup::new("LINUX-SECRET-INVENTORY")?;
    let root = &s.sandbox.workspace;
    let private = s.sandbox.home.join("inaccessible");
    std::fs::create_dir_all(&private)?;
    std::fs::write(private.join("entry"), "private-fixture")?;
    std::fs::create_dir_all(root.join("src"))?;
    std::fs::write(root.join("public"), "complete-public")?;
    butler_platform::secure_fs::symlink(Path::new("../public"), &root.join("src/existing"))?;
    let since = command_sandbox::discover_project_secret_inventory(root)?;
    butler_platform::secure_fs::set_file_mode(
        &private,
        butler_platform::secure_fs::FileMode::from_bits(0),
    )
    .unwrap()?;
    // Restore on every path, including a failed assertion or sweep.
    struct Restore(PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = butler_platform::secure_fs::set_file_mode(
                &self.0,
                butler_platform::secure_fs::FileMode::from_bits(0o700),
            );
        }
    }
    let _restore = Restore(private.clone());
    let denied = private.join("entry").canonicalize().unwrap_err();
    assert_eq!(denied.kind(), std::io::ErrorKind::PermissionDenied);
    let command = format!(
        "set -e; ln -s .env.b src/.env.a; ln -s .env.a src/.env.b; ln -s '{}' src/k.pem; ln -s ../public src/new-public",
        private.join("entry").display()
    );
    let output = run(
        super::secret_links::writable(&s, &command),
        root,
        &s.sandbox.home,
    );
    assert!(output.status.success(), "{output:?}");
    let moved = command_sandbox::sweep_new_secrets(root, &since, &s.sandbox.data)?;
    assert_eq!(
        moved,
        [".env.a", ".env.b", "k.pem"].map(|name| root.join("src").join(name))
    );
    for name in ["existing", "new-public"] {
        assert_eq!(
            std::fs::read_link(root.join("src").join(name))?,
            Path::new("../public")
        );
        assert_eq!(
            std::fs::read_to_string(root.join("src").join(name))?,
            "complete-public"
        );
    }
    // The same unresolvable protected entries must not block a later launch.
    for name in [".env.a", ".env.b", "k.pem"] {
        let target = if name == "k.pem" {
            private.join("entry")
        } else {
            root.join("src")
                .join(if name == ".env.a" { ".env.b" } else { ".env.a" })
        };
        butler_platform::secure_fs::symlink(&target, &root.join("src").join(name))?;
    }
    let output = run(
        super::secret_links::writable(&s, "printf complete"),
        root,
        &s.sandbox.home,
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"complete");
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn new_alias_to_later_created_protected_target_is_quarantined() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux secret inventory");
    let mut s = Setup::new("LINUX-SECRET-LATE-TARGET")?;
    let root = &s.sandbox.workspace;
    std::fs::create_dir_all(root.join("src"))?;
    std::fs::create_dir_all(root.join("links"))?;
    butler_platform::secure_fs::symlink(Path::new("src/missing"), &root.join(".env"))?;
    let since = command_sandbox::discover_project_secret_inventory(root)?;
    // An outside writer can create a protected target after the snapshot.
    std::fs::write(root.join("src/missing"), "private-fixture")?;
    let output = run(
        super::secret_links::writable(&s, "ln -s ../src/missing links/alias"),
        root,
        &s.sandbox.home,
    );
    assert!(output.status.success(), "{output:?}");
    let moved = command_sandbox::sweep_new_secrets(root, &since, &s.sandbox.data)?;
    assert_eq!(moved, [root.join("links/alias")]);
    assert!(std::fs::symlink_metadata(root.join("links/alias")).is_err());
    assert_eq!(
        std::fs::read_link(root.join(".env"))?,
        Path::new("src/missing")
    );
    assert_eq!(
        std::fs::read_to_string(root.join("src/missing"))?,
        "private-fixture"
    );
    s.sandbox.mark_success();
    Ok(())
}
