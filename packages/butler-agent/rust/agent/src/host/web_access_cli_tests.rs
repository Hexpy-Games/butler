use std::ffi::OsString;

use super::parse;

#[test]
fn cli_rejects_home_alias() {
    let home = ["web", "read", "https://example.com", "--home", "/tmp/home"].map(OsString::from);
    assert!(parse(&home).unwrap_err().contains("--home is unsupported"));
}
