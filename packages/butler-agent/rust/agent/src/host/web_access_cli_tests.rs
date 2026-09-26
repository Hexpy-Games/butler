use std::ffi::OsString;

use super::{Command, parse, recognizes};

#[test]
fn cli_routes_search_and_page_read_with_data_options() {
    for args in [
        vec!["search", "status", "--json"],
        vec!["--data", "/tmp/isolated", "search", "test", "rust", "async"],
        vec![
            "web",
            "read",
            "https://example.com",
            "--data",
            "/tmp/isolated",
        ],
    ] {
        let args = args.into_iter().map(OsString::from).collect::<Vec<_>>();
        assert!(recognizes(&args));
        let (_, command) = parse(&args).unwrap();
        assert!(matches!(
            command,
            Some(Command::SearchStatus | Command::SearchTest | Command::WebRead)
        ));
    }
}

#[test]
fn cli_reports_missing_query_and_rejects_home_alias() {
    let missing = vec!["search", "test"]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    assert!(parse(&missing).unwrap_err().contains("requires <query>"));
    let home = vec!["web", "read", "https://example.com", "--home", "/tmp/home"]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    assert!(parse(&home).unwrap_err().contains("--home is unsupported"));
}
