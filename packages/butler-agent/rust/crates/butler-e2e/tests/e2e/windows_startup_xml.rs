//! Pure task-definition checks, including on the owner's Windows build host.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_platform::service_registration::{Definition, test_support};
const SID: &str = "S-1-5-21-123-456-789-1001";
const SHELL: &str = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

// test-category: pure-logic
#[test]
fn windows_task_xml_roundtrip_and_foreign_detection() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let definition = Definition {
        program: std::env::temp_dir()
            .join("버틀러 ' & %HOME% !")
            .join("butler-agent.exe"),
        args: vec![
            "service".into(),
            "run".into(),
            "--data".into(),
            "C:\\미리 보기\\' & %DATA% !".into(),
        ],
        working_dir: "C:\\미리 보기\\' & %DATA% !".into(),
        env: vec![("BUTLER_DATA".into(), "C:\\' & %DATA% !".into())],
    };
    let mut profile = definition.clone();
    profile.env.push(("HOME".into(), "explicit-profile".into()));
    if test_support::task_profile(&mut profile) {
        assert!(
            profile
                .env
                .iter()
                .any(|(key, value)| key == "HOME" && value == "explicit-profile")
        );
        assert_eq!(
            profile.env.iter().filter(|(key, _)| key == "HOME").count(),
            1
        );
        for key in ["USERPROFILE", "LOCALAPPDATA", "APPDATA"] {
            let expected = std::env::var(key).unwrap();
            assert!(
                profile
                    .env
                    .iter()
                    .any(|(name, value)| name == key && value == &expected)
            );
        }
    }
    let xml = test_support::task_xml(&definition, SID, SHELL).unwrap();
    assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
    assert!(xml.contains("<Hidden>true</Hidden>"));
    assert!(xml.contains("<RestartOnFailure>"));
    assert!(xml.contains("-WindowStyle Hidden -EncodedCommand"));
    assert!(xml.contains(
        "<WorkingDirectory>C:\\Windows\\System32\\WindowsPowerShell\\v1.0</WorkingDirectory>"
    ));
    let encoded = xml
        .split("-EncodedCommand ")
        .nth(1)
        .unwrap()
        .split("</Arguments>")
        .next()
        .unwrap();
    let bytes = STANDARD.decode(encoded).unwrap();
    let script = String::from_utf16(
        &bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert!(script.contains("'C:\\미리 보기\\'' & %DATA% !'"));
    assert!(script.contains("SetEnvironmentVariable('BUTLER_DATA','C:\\'' & %DATA% !','Process')"));
    let directory = definition
        .program
        .parent()
        .unwrap()
        .to_string_lossy()
        .replace('\'', "''");
    assert!(script.contains(&format!("Set-Location -LiteralPath '{directory}';")));
    assert!(script.ends_with(";exit $LASTEXITCODE"));
    assert!(
        !script.contains("1>>"),
        "native stdout must remain inherited"
    );
    assert!(
        !script.contains("2>>"),
        "native stderr must remain inherited"
    );
    assert!(test_support::task_owned(&xml, &xml, SID));
    let scheduler = xml
        .replace("<RunLevel>LeastPrivilege</RunLevel>", "")
        .replace("<Enabled>true</Enabled>", "")
        .replace(
            &format!("<UserId>{SID}</UserId></LogonTrigger>"),
            "<UserId>HOST\\runner</UserId></LogonTrigger>",
        );
    assert!(!test_support::task_owned(&xml, &scheduler, SID));
    assert!(test_support::task_owned_for_account(
        &xml,
        &scheduler,
        SID,
        "host\\Runner"
    ));
    assert!(!test_support::task_owned_for_account(
        &xml,
        &scheduler,
        SID,
        "HOST\\other"
    ));
    for foreign in [
        scheduler.replace(
            "</Principal>",
            "<RunLevel>HighestAvailable</RunLevel></Principal>",
        ),
        scheduler.replace("</LogonTrigger>", "<Enabled>false</Enabled></LogonTrigger>"),
        scheduler.replace(
            "</Settings>",
            "<Enabled>true</Enabled><Enabled>false</Enabled></Settings>",
        ),
    ] {
        assert!(!test_support::task_owned_for_account(
            &xml,
            &foreign,
            SID,
            "HOST\\runner"
        ));
    }
    assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-16\"?>"));
    let mut unicode = test_support::task_bytes(&xml);
    assert!(unicode.starts_with(&[0xff, 0xfe, b'<', 0, b'?', 0]));
    assert_eq!(
        &unicode[2..],
        xml.encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>()
    );
    assert_eq!(test_support::task_text(&unicode).unwrap(), xml);
    assert_eq!(test_support::task_text(xml.as_bytes()).unwrap(), xml);
    unicode.push(0);
    assert!(test_support::task_text(&unicode).is_err());
    assert!(test_support::task_text(&[0xff]).is_err());
    let args = test_support::task_arguments(&xml).unwrap();
    assert_eq!(args[0], definition.program.to_string_lossy());
    assert_eq!(&args[1..], &definition.args);
    for remote in [
        xml.replace("LeastPrivilege", "HighestAvailable"),
        xml.replace("<Command>", "<Command>foreign"),
        xml.replace(
            "</Actions>",
            "<Exec><Command>other.exe</Command></Exec></Actions>",
        ),
        xml.replace("</Triggers>", "<BootTrigger/></Triggers>"),
        xml.replace("InteractiveToken", "S4U"),
        xml.replace(SID, "S-1-5-21-999-1001"),
        xml.replace("Butler Agent CLI", "Foreign"),
        "malformed".into(),
    ] {
        assert!(!test_support::task_owned(&xml, &remote, SID));
    }
    assert!(!test_support::task_owned(&xml, &xml, "S-1-5-21-999-1001"));
    let formatted = xml.replace("<Command>", "\n    <Command>").replace(
        "<Enabled>true</Enabled><Hidden>",
        "<Enabled>false</Enabled><Hidden>",
    );
    assert!(test_support::task_owned(&xml, &formatted, SID));
    assert_eq!(test_support::task_enabled(&xml), Some(true));
    assert_eq!(test_support::task_enabled(&formatted), Some(false));
    let mut invalid = definition.clone();
    invalid.args.push("line\nbreak".into());
    assert!(test_support::task_xml(&invalid, SID, SHELL).is_err());
    Ok(())
}

/// The task's script, decoded from its `-EncodedCommand`.
fn task_script(xml: &str) -> String {
    let encoded = xml
        .split("-EncodedCommand ")
        .nth(1)
        .unwrap()
        .split("</Arguments>")
        .next()
        .unwrap();
    let bytes = STANDARD.decode(encoded).unwrap();
    String::from_utf16(
        &bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

// test-category: pure-logic
/// PowerShell ends a single-quoted string at any of its four single quotes, so a user
/// folder such as `C:\Users\O’Brien` must stay one string in the task's script.
#[test]
fn windows_task_script_keeps_typographic_quotes_inside_strings()
-> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let home = "C:\\Users\\O\u{2019}Brien \u{2018}x\u{201a}y\u{201b}";
    let definition = Definition {
        program: format!("{home}\\Butler\\butler-agent.exe").into(),
        args: vec!["--data".into(), format!("{home}\\.butler")],
        working_dir: format!("{home}\\.butler").into(),
        env: vec![("BUTLER_DATA".into(), format!("{home}\\.butler"))],
    };
    let script = task_script(&test_support::task_xml(&definition, SID, SHELL).unwrap());
    let doubled =
        "C:\\Users\\O\u{2019}\u{2019}Brien \u{2018}\u{2018}x\u{201a}\u{201a}y\u{201b}\u{201b}";
    assert!(
        script.contains(&format!("'{doubled}\\Butler\\butler-agent.exe'")),
        "{script}"
    );
    assert!(
        script.contains(&format!(
            "SetEnvironmentVariable('BUTLER_DATA','{doubled}\\.butler','Process')"
        )),
        "{script}"
    );
    assert!(!script.contains("O\u{2019}Brien"), "{script}");
    Ok(())
}

// test-category: pure-logic
/// Each of PowerShell's four single quotes is doubled, so a value stays one string.
#[test]
fn powershell_literal_doubles_every_single_quote() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    assert_eq!(
        butler_platform::powershell_text::literal("a'b\u{2018}c\u{2019}; calc; \u{201a}d\u{201b}e"),
        "'a''b\u{2018}\u{2018}c\u{2019}\u{2019}; calc; \u{201a}\u{201a}d\u{201b}\u{201b}e'"
    );
    Ok(())
}
