use std::ffi::OsString;

use super::{Action, parse, recognizes};

fn arguments(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

#[test]
fn operational_commands_keep_source_cli_shape() {
    for (command, expected) in [("start", "start"), ("stop", "stop"), ("restart", "restart")] {
        let (options, action) = parse(&arguments(&[command, "--data", "/tmp/butler", "--json"]))
            .expect("lifecycle command parses");
        assert!(options.json);
        assert_eq!(options.data.as_deref(), Some("/tmp/butler"));
        assert!(matches!(
            (expected, action),
            ("start", Action::Start) | ("stop", Action::Stop) | ("restart", Action::Restart)
        ));
    }

    let (_, action) = parse(&arguments(&["service", "run", "--data", "/tmp/butler"]))
        .expect("service run parses");
    assert!(matches!(action, Action::Run));
}

#[test]
fn lifecycle_parser_rejects_installation_home_override() {
    let Err(error) = parse(&arguments(&["start", "--home", "/tmp/butler"])) else {
        panic!("--home is not a data directory option");
    };
    assert!(error.contains("--home is unsupported"));
}

#[test]
fn dispatcher_recognizes_lifecycle_and_option_only_service_run() {
    assert!(recognizes(&arguments(&["start", "--dry-run"])));
    assert!(recognizes(&arguments(&["--data", "/tmp/butler", "--json"])));
    assert!(!recognizes(&arguments(&[
        "cognition",
        "memory",
        "maintain"
    ])));
}

#[test]
fn restart_handoff_is_a_hidden_identity_bound_service_command() {
    let args = arguments(&[
        "service",
        "restart-handoff",
        "--data",
        "/tmp/butler-data",
        "--quiet",
    ]);
    assert!(recognizes(&args));
    let (options, action) = parse(&args).expect("private handoff arguments parse");
    assert!(matches!(action, Action::RestartHandoff));
    assert_eq!(options.data.as_deref(), Some("/tmp/butler-data"));
    assert!(options.quiet);
}

#[test]
fn restart_handoff_identity_is_never_accepted_from_argv() {
    assert!(
        parse(&arguments(&[
            "service",
            "restart-handoff",
            "--data",
            "/tmp/data",
            "--expected-nonce",
            "private-nonce"
        ]))
        .is_err()
    );
    assert!(
        parse(&arguments(&[
            "restart",
            "--data",
            "/tmp/data",
            "--intent-id",
            "x"
        ]))
        .is_err()
    );
}
