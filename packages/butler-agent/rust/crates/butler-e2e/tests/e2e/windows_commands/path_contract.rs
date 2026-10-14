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
    let root = std::env::temp_dir().join("data");
    let parent = root.parent().unwrap();
    for (requested, expected) in [
        ("../Downloads/a.txt", parent.join("Downloads").join("a.txt")),
        ("./x/../y.txt", root.join("y.txt")),
        ("a/./b", root.join("a").join("b")),
    ] {
        let resolved = resolve(&root, requested)?;
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
