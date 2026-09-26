use std::ffi::OsString;

use super::recognizes;

#[test]
fn routes_observability_subcommands_without_swallowing_metrics_status() {
    for args in [
        vec!["metrics", "enable"],
        vec!["metrics", "disable"],
        vec!["metrics", "tail"],
        vec!["logs"],
        vec!["ps"],
    ] {
        assert!(recognizes(
            &args.into_iter().map(OsString::from).collect::<Vec<_>>()
        ));
    }
    for args in [vec!["metrics", "status"], vec!["model", "list"]] {
        assert!(!recognizes(
            &args.into_iter().map(OsString::from).collect::<Vec<_>>()
        ));
    }
    let positioned = vec!["--data", "/tmp/isolated", "metrics", "tail"]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    assert!(recognizes(&positioned));
    let malformed_option = vec!["metrics", "tail", "--lines"]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    assert!(recognizes(&malformed_option));
}
