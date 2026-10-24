//! Approved commands keep the user's writes and network while the kernel
//! keeps credential stores and Butler's secrets unreadable, whatever shell
//! construct names them. Hosts that cannot deny those reads refuse.

use std::collections::HashMap;
use std::process::Command;

use butler_platform::command_sandbox::{
    SandboxError, ShellAccess, deny_secret_reads, login_shell, secret_reads_deniable,
};

use super::scratch;

const KEY: &str = "fixture-private-key";

#[cfg(unix)]
type Runner<'a> = &'a dyn Fn(&str, &HashMap<String, String>) -> (bool, String);

pub(super) fn verify() {
    let directory = scratch("secret-reads");
    let home = directory.join("home");
    let data = directory.join("data");
    let project = directory.join("project");
    for folder in [home.join(".ssh"), data.join("auth"), project.clone()] {
        std::fs::create_dir_all(folder).unwrap();
    }
    std::fs::write(home.join(".ssh/id_ed25519"), KEY).unwrap();
    std::fs::write(home.join(".ssh/known_hosts"), "fixture-known-host").unwrap();
    std::fs::write(data.join("auth/provider.json"), KEY).unwrap();
    let environment = HashMap::from([
        ("HOME".to_owned(), home.display().to_string()),
        ("BUTLER_DATA".to_owned(), data.display().to_string()),
    ]);
    let shell = login_shell("true", ShellAccess::Full, &environment).unwrap();
    assert_eq!(secret_reads_deniable(), cfg!(target_os = "macos"));
    if !secret_reads_deniable() {
        assert!(matches!(
            deny_secret_reads(shell, &environment, None),
            Err(SandboxError::SecretReadsUnavailable)
        ));
        return;
    }
    let run = |command: &str, environment: &HashMap<String, String>| {
        let shell = login_shell(command, ShellAccess::Full, environment).unwrap();
        let denied = deny_secret_reads(shell, environment, None).unwrap();
        assert_eq!(denied.program, "/usr/bin/sandbox-exec");
        let output = Command::new(&denied.program)
            .args(&denied.arguments)
            .current_dir(&project)
            .env_clear()
            .envs(environment)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        (output.status.success(), stdout)
    };
    for command in [
        r#"cat "$HOME/.ssh/id_ed25519""#,
        r#"cat "$(printf '%s/.s%s/id_ed25519' "$HOME" sh)""#,
        r#"d=.ss; cat "$HOME/${d}h/"*"#,
        r#"ln -s "$HOME/.ssh" keys && cat keys/id_ed25519"#,
        r#"ln "$HOME/.ssh/id_ed25519" hard; cat hard"#,
        r#"cd "$BUTLER_DATA" && cat ./auth/provider.json"#,
        r#"cd "$HOME" && cat .SSH/ID_ED25519"#,
        r#"mv "$HOME/.ssh" "$HOME/moved"; cat "$HOME/moved/id_ed25519""#,
        r#"mv "$HOME/.ssh/id_ed25519" .; cat id_ed25519"#,
        r#"mv "$HOME" "$HOME-moved"; cat "$HOME-moved/.ssh/id_ed25519""#,
        r#"printf planted > "$HOME/.ssh/config""#,
    ] {
        let (succeeded, stdout) = run(command, &environment);
        assert!(!succeeded, "{command}");
        assert!(!stdout.contains(KEY), "{command} printed the secret");
    }
    assert!(home.join(".ssh/id_ed25519").is_file());
    assert!(!home.join(".ssh/config").exists());
    let (succeeded, stdout) = run("printf written > out && cat out", &environment);
    assert!(succeeded && stdout == "written", "{stdout}");
    // Without an agent, OpenSSH's own files stay denied with the keys.
    let (succeeded, _) = run(r#"cat "$HOME/.ssh/known_hosts""#, &environment);
    assert!(!succeeded);
    #[cfg(unix)]
    agent_reads_only_host_files(&environment, &run);
}

/// A live agent socket opens the known-hosts file to the command, never a key.
#[cfg(unix)]
fn agent_reads_only_host_files(environment: &HashMap<String, String>, run: Runner<'_>) {
    // Socket paths are short (SUN_LEN); the scratch folder may be too deep.
    let socket = std::env::temp_dir().join(format!("bsr-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let mut environment = environment.clone();
    environment.insert("SSH_AUTH_SOCK".into(), socket.display().to_string());
    let (succeeded, stdout) = run(r#"cat "$HOME/.ssh/known_hosts""#, &environment);
    assert!(succeeded && stdout == "fixture-known-host", "{stdout}");
    let (succeeded, stdout) = run(r#"cat "$HOME/.ssh/id_ed25519""#, &environment);
    assert!(!succeeded && !stdout.contains(KEY));
    std::fs::remove_file(socket).unwrap();
}
