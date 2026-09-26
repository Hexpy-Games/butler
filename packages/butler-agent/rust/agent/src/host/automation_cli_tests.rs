use std::ffi::OsString;

use super::{Command, recognizes};

fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

#[test]
fn automation_commands_route_with_common_options_and_keep_unknowns_native() {
    assert!(recognizes(&args(&["automation", "list"])));
    assert!(recognizes(&args(&[
        "--data",
        "/tmp/butler-data",
        "automation",
        "list",
        "--status",
        "active",
        "--include-deleted",
        "--json"
    ])));
    assert!(recognizes(&args(&["automation", "future-command"])));
    assert!(!recognizes(&args(&["model", "status"])));
    assert_eq!(
        Command::parse(&["automation".into(), "run".into(), "job-1".into()]),
        Some(Command::Run("job-1".into()))
    );
    assert_eq!(
        Command::parse(&["automation".into(), "show".into()]),
        Some(Command::MissingId("show"))
    );
    assert_eq!(
        Command::parse(&[
            "automation".into(),
            "show".into(),
            "job-1".into(),
            "extra".into()
        ]),
        Some(Command::Unknown)
    );
}
