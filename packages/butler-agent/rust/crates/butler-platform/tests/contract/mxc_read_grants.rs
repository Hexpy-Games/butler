//! Permission-preserving rule reduction, under the existing security contract.
use super::*;

pub(super) fn verify() {
    let mut p = plan();
    p.tools.readonly = [
        r"C:\Tools\bin",
        r"C:\Tools",
        r"C:\Tools",
        r"C:\ToolsOther",
        r"C:\Windows\System32",
        r"C:\work",
    ]
    .map(path)
    .to_vec();
    p.tools.path = [r"C:\Tools\bin", r"C:\ToolsOther"].map(path).to_vec();
    let result = p
        .build(&invocation(&[]), 'L', 1500, &command_scratch())
        .unwrap();
    assert_eq!(
        result["filesystem"]["readonlyPaths"],
        serde_json::json!([
            "c:\\tools",
            "c:\\toolsother",
            "c:\\work",
            "c:\\windows",
            "c:\\work\\project\\.git",
            "c:\\work\\project\\sub\\.git"
        ])
    );
    // The project is writable below C:\work; its .git boundaries must survive.
    assert_eq!(
        result["filesystem"]["readwritePaths"][0],
        "c:\\work\\project"
    );
    let ordinary = plan()
        .build(&invocation(&[]), 'L', 1500, &command_scratch())
        .unwrap();
    assert_eq!(
        result["filesystem"]["deniedPaths"],
        ordinary["filesystem"]["deniedPaths"]
    );
    assert!(
        result["process"]["env"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry
                    .as_str()
                    .is_some_and(|entry| entry.ends_with(";c:\\tools\\bin;c:\\toolsother"))
            })
    );
    // Invalid grants remain invalid even if an ancestor could subsume them.
    p.tools
        .readonly
        .push(path(r"C:\work\project\sub\.env\child"));
    assert!(
        p.build(&invocation(&[]), 'L', 1500, &command_scratch())
            .is_err()
    );
}
