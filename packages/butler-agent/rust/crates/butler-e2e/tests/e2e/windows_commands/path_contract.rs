#![allow(clippy::unwrap_used, reason = "contract assertions")]
//! Platform path contracts, including Windows forms on Linux.
use butler_platform::tool_paths::*;
use std::path::Path;

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
    Ok(())
}

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
    assert!(expand_home("~/dev", None).is_err());
    for (input, expected) in [
        (r"C:\", "C:/"),
        ("/", "/"),
        ("./dir/", "dir"),
        (r"\\server\share\", "//server/share"),
    ] {
        assert_eq!(discovery_root(input), expected);
    }
    Ok(())
}
