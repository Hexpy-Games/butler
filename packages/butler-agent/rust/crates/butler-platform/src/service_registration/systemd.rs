//! The systemd user unit: its text (every Unix host can render it) and, off
//! macOS, the `systemctl --user` calls that manage it.

use super::Definition;

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
        .map(|(key, value)| format!("Environment={key}={}\n", quoted(value)))
        .collect::<Vec<_>>()
        .concat();
    let command = std::iter::once(definition.program.to_string_lossy().into_owned())
        .chain(definition.args.iter().cloned())
        .map(|value| quoted(&value))
        .collect::<Vec<_>>()
        .join(" ");
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
            "WorkingDirectory={}",
            path_value(&definition.working_dir.to_string_lossy())
        ),
        format!("{environment}ExecStart={command}"),
        "Restart=on-failure".to_owned(),
        // A SIGKILL is a forced stop (`butler stop` after its grace period),
        // not a crash to recover from.
        "RestartPreventExitStatus=SIGKILL".to_owned(),
        "RestartSec=5".to_owned(),
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

/// A value in double quotes; `%` is a specifier and `$` starts a variable in
/// unit files.
pub(super) fn quoted(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    )
}

/// The program the unit runs: the first word of `ExecStart=`.
#[cfg(not(target_os = "macos"))]
pub(super) fn program(text: &str) -> Option<String> {
    let command = text
        .lines()
        .find_map(|line| line.strip_prefix("ExecStart="))?;
    let mut characters = command.strip_prefix('"')?.chars();
    let mut program = String::new();
    while let Some(character) = characters.next() {
        match character {
            '"' => return Some(program.replace("%%", "%").replace("$$", "$")),
            '\\' => program.push(characters.next()?),
            other => program.push(other),
        }
    }
    None
}

/// A path for `WorkingDirectory=`, which takes no quotes: anything outside a
/// safe set is escaped byte by byte.
pub(super) fn path_value(value: &str) -> String {
    let mut escaped = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '/' | '_' | '.' | ':' | '-') {
            escaped.push(character);
        } else {
            let mut buffer = [0_u8; 4];
            for byte in character.encode_utf8(&mut buffer).bytes() {
                escaped.push_str(&format!("\\x{byte:02x}"));
            }
        }
    }
    escaped
}
