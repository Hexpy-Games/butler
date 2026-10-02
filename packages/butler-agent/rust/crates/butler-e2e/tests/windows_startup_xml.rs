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
    let xml = test_support::task_xml(&definition, SID, SHELL).unwrap();
    assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
    assert!(xml.contains("<Hidden>true</Hidden>"));
    assert!(xml.contains("<RestartOnFailure>"));
    assert!(xml.contains("-WindowStyle Hidden -EncodedCommand"));
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
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert!(script.contains("'C:\\미리 보기\\'' & %DATA% !'"));
    assert!(script.contains("SetEnvironmentVariable('BUTLER_DATA','C:\\'' & %DATA% !','Process')"));
    assert!(script.ends_with(";exit $LASTEXITCODE"));
    assert!(test_support::task_owned(&xml, &xml, SID));
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
