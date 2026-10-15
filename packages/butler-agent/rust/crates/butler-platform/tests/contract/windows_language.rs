//! Regression for the real shell prelude under an enforced language mode.
use butler_platform::command_sandbox::{ShellAccess, add_arguments, login_shell};
use std::{collections::HashMap, process::Command};

pub(super) fn verify() {
    let root = super::scratch("constrained-language");
    std::fs::create_dir_all(&root).unwrap();
    let ok = run(
        &format!(
            "$ErrorActionPreference='Stop'; Set-Content -LiteralPath 'made.txt' -Value 'complete'; Get-Content -LiteralPath 'made.txt'; Write-Output '한국어'; #{}",
            "long comment ".repeat(1000)
        ),
        &root,
    );
    assert!(ok.status.success(), "{ok:?}");
    assert!(String::from_utf8_lossy(&ok.stdout).contains("complete"));
    assert!(
        String::from_utf8_lossy(&ok.stdout).contains("한국어"),
        "{ok:?}"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("made.txt"))
            .unwrap()
            .trim(),
        "complete"
    );
    let blocked = run(
        "$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('blocked.txt','bad')",
        &root,
    );
    assert!(!blocked.status.success(), "{blocked:?}");
    assert!(!root.join("blocked.txt").exists());
    assert!(
        String::from_utf8_lossy(&blocked.stderr)
            .contains("MethodInvocationNotSupportedInConstrainedLanguage"),
        "{blocked:?}"
    );
    std::fs::remove_dir_all(root).unwrap();
}
fn run(script: &str, root: &std::path::Path) -> std::process::Output {
    let mut invocation = login_shell(script, ShellAccess::Full, &HashMap::new()).unwrap();
    invocation.shell_script = Some(format!(
        "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'; {}",
        invocation.shell_script.take().unwrap()
    ));
    let mut command = Command::new(&invocation.program);
    command.current_dir(root);
    add_arguments(&mut command, &invocation);
    command.output().unwrap()
}
