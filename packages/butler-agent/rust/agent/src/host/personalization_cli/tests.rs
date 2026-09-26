use std::ffi::OsString;

use super::{Command, positionals_without_common_options, recognizes};

fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

#[test]
fn routes_personalization_aliases_before_generic_status() {
    assert!(recognizes(&args(&["personalization"])));
    assert!(recognizes(&args(&[
        "--data",
        "/tmp/profile-data",
        "personalization",
        "show"
    ])));
    assert!(recognizes(&args(&[
        "personalization",
        "migrate",
        "import",
        "--stdin"
    ])));
    assert!(!recognizes(&args(&["model", "status"])));
    assert_eq!(
        Command::parse(&positionals_without_common_options(&args(&[
            "personalization",
            "get"
        ]))),
        Some(Command::Show)
    );
}

#[test]
fn migration_prompt_and_import_are_distinct_commands() {
    assert_eq!(
        Command::parse(&args(&["personalization", "migration", "prompt"])),
        Some(Command::MigrationPrompt)
    );
    assert_eq!(
        Command::parse(&args(&[
            "personalization",
            "migration",
            "import",
            "--file",
            "export.txt"
        ])),
        Some(Command::MigrationImport)
    );
    assert_eq!(
        Command::parse(&args(&["personalization", "migration", "unknown"])),
        Some(Command::Unknown)
    );
}
