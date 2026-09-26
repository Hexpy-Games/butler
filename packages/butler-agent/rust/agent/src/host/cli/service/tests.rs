use std::ffi::OsString;

use super::parse;

fn arguments(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

#[test]
fn lifecycle_parser_rejects_installation_home_override() {
    let Err(error) = parse(&arguments(&["start", "--home", "/tmp/butler"])) else {
        panic!("--home is not a data directory option");
    };
    assert!(error.contains("--home is unsupported"));
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
