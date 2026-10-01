//! The systemd user unit: its text (every Unix host can render it) and, off
//! macOS, the `systemctl --user` calls that manage it.

use super::{Definition, STOP_GRACE_SECONDS};

#[cfg(not(target_os = "macos"))]
pub(super) mod manage;

/// Crash budget: three starts a minute, then the unit stays failed.
const START_LIMIT_INTERVAL_SECONDS: u32 = 60;
const START_LIMIT_BURST: u32 = 3;

/// The unit file. `Restart=on-failure` restarts the service after a crash
/// only: an intentional stop exits 0, and `systemctl stop` never restarts.
pub(super) fn render(definition: &Definition) -> String {
    // A login unit starts with a minimal environment; the installing shell's
    // PATH is not copied into it.
    let fixed_path = ("PATH".to_owned(), UNIT_PATH.to_owned());
    let environment = definition
        .env
        .iter()
        .filter(|(key, _)| key != "PATH")
        .chain(std::iter::once(&fixed_path))
        .map(|(key, value)| format!("Environment={key}={}\n", environment_quoted(value)))
        .collect::<Vec<_>>()
        .concat();
    let command = std::iter::once(definition.program.to_string_lossy().into_owned())
        .chain(definition.args.iter().cloned())
        .map(|value| exec_quoted(&value))
        .collect::<Vec<_>>()
        .join(" ");
    // No `WorkingDirectory=`: a user unit starts in the user's home, and the
    // service takes its data folder from `--data`.
    let lines = [
        "[Unit]".to_owned(),
        "Description=Butler Agent service".to_owned(),
        "After=network-online.target".to_owned(),
        format!("StartLimitIntervalSec={START_LIMIT_INTERVAL_SECONDS}"),
        format!("StartLimitBurst={START_LIMIT_BURST}"),
        String::new(),
        "[Service]".to_owned(),
        "Type=simple".to_owned(),
        format!(
            "StandardOutput={}",
            environment_quoted(&format!(
                "append:{}",
                definition
                    .working_dir
                    .join("logs/butler-agent-service.stdout.log")
                    .display()
            ))
        ),
        format!(
            "StandardError={}",
            environment_quoted(&format!(
                "append:{}",
                definition
                    .working_dir
                    .join("logs/butler-agent-service.stderr.log")
                    .display()
            ))
        ),
        format!("{environment}ExecStart={command}"),
        "Restart=on-failure".to_owned(),
        "RestartSec=5".to_owned(),
        // How long systemd waits for the process to exit before it kills it.
        format!("TimeoutStopSec={STOP_GRACE_SECONDS}"),
        "KillMode=control-group".to_owned(),
        String::new(),
        "[Install]".to_owned(),
        "WantedBy=default.target".to_owned(),
        String::new(),
    ];
    lines.join("\n")
}

/// The `PATH` of the unit.
const UNIT_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// A word of `ExecStart=` in double quotes: `\` and `"` are escaped, `%` is a
/// specifier and `$` starts a variable there.
pub(super) fn exec_quoted(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    )
}

/// A value of `Environment=` in double quotes: `$` has no meaning there, but
/// `%` is still a specifier.
pub(super) fn environment_quoted(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}

/// The words of `ExecStart=`: the program, then its arguments.
#[cfg(not(target_os = "macos"))]
pub(super) fn arguments(text: &str) -> Vec<String> {
    let Some(command) = text
        .lines()
        .find_map(|line| line.strip_prefix("ExecStart="))
    else {
        return Vec::new();
    };
    let mut words = Vec::new();
    let mut characters = command.chars();
    while let Some(start) = characters.next() {
        if start != '"' {
            continue;
        }
        let mut word = String::new();
        while let Some(character) = characters.next() {
            match character {
                '"' => break,
                '\\' => word.extend(characters.next()),
                other => word.push(other),
            }
        }
        words.push(word.replace("%%", "%").replace("$$", "$"));
    }
    words
}
