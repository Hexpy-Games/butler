#![allow(clippy::unwrap_used, reason = "contract assertions")]
//! Platform path contracts, including Windows forms on Linux.
use butler_platform::tool_paths::*;
use std::path::Path;

// test-category: pure-logic
#[test]
fn windows_forms_keep_their_roots() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    for (root, requested, expected) in [
        (r"D:\butler\data", r"\Users\x\a.txt", "D:/Users/x/a.txt"),
        (r"D:\butler\data", "/Users/x/a.txt", "D:/Users/x/a.txt"),
        (r"\\?\D:\butler\data", "/Users/x/a.txt", "D:/Users/x/a.txt"),
        (r"D:\butler\data", r"C:\", "C:/"),
        (r"D:\butler\data", r"C:\Users/x\a.txt", "C:/Users/x/a.txt"),
        (
            r"D:\butler\data",
            r"\\server\share/a.txt",
            "//server/share/a.txt",
        ),
        (
            r"\\server\share\data",
            r"\Users\a.txt",
            "//server/share/Users/a.txt",
        ),
        (r"D:\butler\data", r"relative\a.txt", "relative/a.txt"),
    ] {
        assert_eq!(windows_rooted(root, requested).unwrap(), expected);
    }
    assert!(windows_rooted("D:/data", "C:relative").is_err());
    assert!(windows_rooted("data", "/Users/a").is_err());
    assert!(windows_rooted("1:/data", "/Users/a").is_err());
    assert_eq!(windows_rooted("D:/data", "1:/x").unwrap(), "1:/x");
    assert!(!has_windows_root("1:/x"));
    assert!(has_windows_root("C:/x"));
    Ok(())
}

// test-category: pure-logic
#[test]
fn home_and_discovery_roots_are_preserved() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    for value in ["~", "~/", "~\\"] {
        assert_eq!(
            expand_home(value, Some(Path::new("/home/test"))).unwrap(),
            "/home/test/"
        );
    }
    for value in ["~/dev", "~\\dev"] {
        assert_eq!(
            expand_home(value, Some(Path::new("/home/test"))).unwrap(),
            "/home/test/dev"
        );
    }
    assert_eq!(expand_home("~other/dev", None).unwrap(), "~other/dev");
    assert_eq!(
        expand_home("~/dev", None).unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );
    assert_eq!(
        parse(Path::new("."), "bad\0path").unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );
    for (input, expected) in [
        (r"C:\", "C:/"),
        ("/", "/"),
        ("./dir/", "dir"),
        (r"\\server\share\", "//server/share"),
    ] {
        assert_eq!(discovery_root(input), expected);
    }
    // Approval targets: the real path in native separators, `..` resolved.
    // Expected values use the root's own components: a TMPDIR spelling such
    // as `T//` is one native separator in the resolved path.
    let raw = std::env::temp_dir().join("data");
    let root = raw.components().collect::<std::path::PathBuf>();
    let parent = root.parent().unwrap();
    for (requested, expected) in [
        ("../Downloads/a.txt", parent.join("Downloads").join("a.txt")),
        ("./x/../y.txt", root.join("y.txt")),
        ("a/./b", root.join("a").join("b")),
    ] {
        let resolved = resolve(&raw, requested)?;
        assert_eq!(resolved.to_string_lossy(), expected.to_string_lossy());
    }
    assert_eq!(lexical(Path::new("/../a")), Path::new("/a"));
    assert_eq!(lexical(Path::new("../../a/./b")), Path::new("../../a/b"));
    Ok(())
}

// test-category: security
#[test]
fn command_directory_rejections_preserve_contained_scope()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    use butler_turn::workspace::{Commands, PathForm};
    let setup = butler_e2e::e2e::scenario::Setup::new("CONTAINED-CWD")?;
    let root = &setup.sandbox.workspace;
    let outside = setup.sandbox.home.to_string_lossy();
    let error = Commands::guarded_directory_in_scope(root, Some(&outside), PathForm::Contained)
        .unwrap_err();
    assert_eq!(error.code(), "path_escape");
    assert!(
        error
            .message()
            .contains("Use a path inside the session workspace root.")
    );
    assert!(error.message().contains(root.to_string_lossy().as_ref()));
    let allowed =
        Commands::guarded_directory_in_scope(root, Some(&outside), PathForm::RelativeOrAbsolute)
            .unwrap();
    assert_eq!(allowed, setup.sandbox.home);
    Ok(())
}

#[test]
fn cmd_switches_do_not_become_outside_paths() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    use butler_platform::command_sandbox::{POSIX_SHELL, normalize_path_token, path_tokens};
    use butler_turn::workspace::{ScopeRoots, TargetScope, classify_targets};
    butler_e2e::skip_unless!(!POSIX_SHELL, "Windows cmd scope");
    let mut setup = butler_e2e::e2e::scenario::Setup::new("CMD-SCOPE")?;
    let root = &setup.sandbox.workspace;
    let roots = ScopeRoots {
        project: Some(root),
        butler_data: &setup.sandbox.data,
        protected_ledger_roots: &[],
        installation_root: None,
    };
    // Reproduce the former approval: /c was classified as a drive-root path.
    assert_eq!(
        classify_targets(&roots, root, &["cmd", "/c", "compile.cmd"]),
        TargetScope::Outside
    );
    for (command, scope) in [
        ("cmd /c compile.cmd", TargetScope::ProjectFolder),
        (
            "cmd.exe /d /s /c echo done > result.txt",
            TargetScope::ProjectFolder,
        ),
        ("cmd /c echo denied > ../outside.txt", TargetScope::Outside),
        ("cmd /c type .git/config", TargetScope::Protected),
    ] {
        let targets: Vec<_> = path_tokens(command)
            .into_iter()
            .map(normalize_path_token)
            .collect();
        let refs: Vec<_> = targets.iter().map(String::as_str).collect();
        assert_eq!(classify_targets(&roots, root, &refs), scope, "{command}");
    }
    setup.sandbox.mark_success();
    Ok(())
}
