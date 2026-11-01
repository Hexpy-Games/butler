//! `cmd.exe` and PowerShell.

use base64::{Engine, engine::general_purpose::STANDARD};
use std::collections::HashMap;

use super::Invocation;

mod cmd;
mod cwd;
pub(super) mod mxc;
pub(super) use cwd::working_directory;

pub(super) const ESCAPE: char = '`';

pub(super) const POSIX: bool = false;

pub(super) fn member_access_dot(ch: char, previous: Option<char>, quoted: bool) -> bool {
    ch == '.' && previous == Some(')') && !quoted
}

pub(super) fn path_script(command: &str) -> &str {
    cmd::script(command)
        .or_else(|| explicit_script(command))
        .unwrap_or(command)
}

/// `cmd.exe /d /s /c <command>` takes the command verbatim: with `/s`, `cmd`
/// strips the first and the last quote of the line and runs what is between.
pub(super) fn add_arguments(command: &mut std::process::Command, invocation: &Invocation) {
    use std::os::windows::process::CommandExt;
    if let Some(shell) = &invocation.shell_program {
        command.env("BUTLER_COMMAND_SHELL", shell);
        if let Some(script) = &invocation.shell_script {
            command.env("BUTLER_COMMAND_SCRIPT", script);
        }
        if let Some(directory) = command.get_current_dir().map(std::path::Path::to_path_buf) {
            command.env("BUTLER_COMMAND_CWD", directory);
        }
    }
    if let Some(text) = cmd::raw_argument(invocation) {
        command.arg("/d");
        if invocation.arguments.iter().any(|a| a == "/v:on") {
            command.arg("/v:on");
        }
        command.args(["/s", "/c"]).raw_arg(text);
    } else {
        command.args(&invocation.arguments);
        let powershell = std::path::Path::new(&invocation.program)
            .file_stem()
            .is_some_and(|name| {
                name.eq_ignore_ascii_case("powershell") || name.eq_ignore_ascii_case("pwsh")
            });
        if powershell
            && invocation.arguments.len() == 9
            && invocation.arguments.iter().take(8).map(String::as_str).eq([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-OutputFormat",
                "Text",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
            ])
            && let Some(directory) = command.get_current_dir().map(std::path::Path::to_path_buf)
        {
            command.env("BUTLER_COMMAND_CWD", directory);
        }
    }
}

pub(super) fn login_shell(command: &str, environment: &HashMap<String, String>) -> Invocation {
    let environment = environment
        .iter()
        .map(|(key, value)| (key.clone(), Some(value.clone())))
        .collect();
    legacy_shell(command, false, &environment)
}

/// A user hook's `command` text runs in `cmd.exe /d /s /c`, the shell the hook
/// documentation names, not in the PowerShell that model commands use: cmd
/// syntax such as `echo {"decision":"deny"}` is a parse error in PowerShell.
///
/// Built-ins cache the code page cmd started with, so `chcp 65001` must come
/// before a fresh cmd that runs the text; otherwise `echo` of a Korean reason
/// would write CP949, which is not UTF-8. The text travels in the environment
/// and the outer cmd expands it late (`!var!`), after its own parsing, so its
/// operators and quotes belong to the inner cmd only.
pub(super) fn hook_shell(command: &str, environment: &HashMap<String, String>) -> Invocation {
    let environment = environment
        .iter()
        .map(|(key, value)| (key.clone(), Some(value.clone())))
        .collect();
    let mut program = cmd::program(&environment);
    if program.contains(['"', '\r', '\n', '\0']) {
        program = "cmd.exe".into();
    }
    Invocation {
        arguments: vec![
            "/d".into(),
            "/v:on".into(),
            "/s".into(),
            "/c".into(),
            format!("chcp 65001>nul & \"{program}\" /d /s /c \"!{HOOK_TEXT}!\""),
        ],
        shell_program: Some(program.clone()),
        shell_script: Some(command.to_owned()),
        program,
        ..Default::default()
    }
}

/// The variable `add_arguments` fills from `Invocation::shell_script`.
const HOOK_TEXT: &str = "BUTLER_COMMAND_SCRIPT";

pub(super) fn legacy_shell(
    command: &str,
    _pipefail: bool,
    environment: &HashMap<String, Option<String>>,
) -> Invocation {
    if cmd::script(command).is_some() {
        return cmd::shell(command, environment);
    }
    let program = environment
        .get("BUTLER_POWERSHELL")
        .and_then(Option::as_deref)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("powershell.exe")
        .to_owned();
    let command = explicit_script(command).unwrap_or(command);
    // EncodedCommand preserves nested quotes and multi-line scripts without
    // cmd/CRT/PowerShell argument reparsing. Set both console and pipeline
    // encodings; native reg/cmd output follows the console code page.
    // Keep the inner imports: NUL, quote, CR or LF in the program path makes
    // code_page_shell retain the direct -EncodedCommand invocation. Wrapped
    // transports repeat Import-Module, which does not reload an already loaded module.
    let modules = default_modules();
    let shell_started = phase_marker("script_started", environment);
    let language = include_str!("windows/language.ps1");
    let modules_ready = phase_marker("modules_ready", environment);
    // Enter the admitted short CWD with process-local .NET path compatibility.
    // Long folders retain an extended provider root and real parent traversal.
    let paths = include_str!("windows/paths.ps1");
    // Invoke-Expression otherwise resets $? after non-terminating errors.
    // Preserve the direct -EncodedCommand transport's final-status behavior.
    let script = format!(
        "{language}{shell_started}{modules}{modules_ready}{paths}{command}\nif (!$?) {{ exit 1 }}\n"
    );
    let encoded = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let invocation = Invocation {
        program,
        arguments: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-OutputFormat",
            "Text",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ]
        .map(str::to_owned)
        .to_vec(),
        ..Default::default()
    };
    code_page_shell(invocation, script, environment)
}

fn code_page_shell(
    mut invocation: Invocation,
    script: String,
    environment: &HashMap<String, Option<String>>,
) -> Invocation {
    // cmd sets the console code page before PowerShell caches its output
    // encoding. This also works when policy prohibits Console setters in CLM.
    // Expand the path once from the environment, with delayed expansion off:
    // spaces, percent signs and exclamation marks retain their literal values.
    if invocation.program.contains(['\0', '"', '\r', '\n']) {
        return invocation;
    }
    // Environment transport avoids cmd's 8191-character command-line limit.
    // Invoke-Expression obeys the current language policy, including CLM.
    let bootstrap = format!(
        "{}$butlerCommandText=$env:BUTLER_COMMAND_SCRIPT; Remove-Item Env:BUTLER_COMMAND_SCRIPT; Invoke-Expression $butlerCommandText",
        bootstrap_modules()
    );
    let encoded = STANDARD.encode(
        bootstrap
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    if let Some(argument) = invocation.arguments.last_mut() {
        *argument = encoded;
    }
    let text = format!(
        "\"%BUTLER_COMMAND_SHELL%\" {}",
        invocation.arguments.join(" ")
    );
    let mut wrapper = cmd::shell(&text, environment);
    wrapper.arguments.insert(1, "/v:off".into());
    wrapper.shell_program = Some(invocation.program);
    wrapper.shell_script = Some(script);
    wrapper
}

fn phase_marker(phase: &str, environment: &HashMap<String, Option<String>>) -> String {
    // Parent diagnostics must not contaminate captured command output. Only an
    // explicit opt-in on this invocation may add shell diagnostics to stderr.
    if environment
        .get("BUTLER_DEBUG_COMMAND_TIMINGS")
        .and_then(Option::as_deref)
        != Some("1")
    {
        return String::new();
    }
    // Opt-in diagnostics contain no command, path, environment or output data.
    // UTC ticks correlate shell startup/imports with the parent spawn interval.
    format!(
        "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {{ [Console]::Error.WriteLine('command_shell_phase phase={phase} utc_ticks=' + [DateTime]::UtcNow.Ticks) }}; "
    )
}

fn default_modules() -> &'static str {
    // Load trusted built-ins before changing provider location or path policy.
    // Initialize them while the normal filesystem drives are still active.
    // Preserve PSModulePath for explicitly requested custom modules.
    // Single quotes keep this usable inside a double-quoted -Command argument.
    "Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1'); Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1'); "
}

/// Prefix for every outer bootstrap that calls a built-in cmdlet before the
/// command script runs. Resolving `Remove-Item` or `Invoke-Expression` by
/// name first would auto-discover modules across the whole PSModulePath on
/// every command. Importing the two built-ins from `$PSHOME` avoids that scan.
/// Progress is suppressed first: the script's own preference applies too late.
pub(super) fn bootstrap_modules() -> String {
    format!(
        "$ProgressPreference='SilentlyContinue'; {}",
        default_modules()
    )
}

// The tool accepts the common cmd-style `powershell.exe -Command "script"`.
// Running that through another PowerShell expands $variables in the outer
// double-quoted argument before the requested script ever sees them. Standard
// startup switches are already enforced by our invocation; run the script once.
fn explicit_script(command: &str) -> Option<&str> {
    let (program, tail) = command.trim().split_once(char::is_whitespace)?;
    if !program.eq_ignore_ascii_case("powershell.exe")
        && !program.eq_ignore_ascii_case("powershell")
    {
        return None;
    }
    let offset = tail.to_ascii_lowercase().find("-command ")?;
    let prefix = tail.get(..offset)?;
    let mut arguments = prefix.split_whitespace();
    while let Some(argument) = arguments.next() {
        match argument.to_ascii_lowercase().as_str() {
            "-nologo" | "-noprofile" | "-noninteractive" => {}
            "-executionpolicy"
                if arguments
                    .next()
                    .is_some_and(|value| value.eq_ignore_ascii_case("Bypass")) => {}
            _ => return None,
        }
    }
    tail.get(offset + "-command ".len()..)?
        .trim()
        .strip_prefix('"')?
        .strip_suffix('"')
}

/// Both reg.exe key paths and PowerShell registry-provider paths.
pub(super) fn normalize_path_token(path: &str) -> String {
    path.replace('\\', "/")
}

pub(super) fn is_registry_path(path: &str) -> bool {
    let root = path.split(['/', '\\', ':']).next().unwrap_or_default();
    [
        "HKCU",
        "HKLM",
        "HKCR",
        "HKU",
        "HKCC",
        "HKEY_CURRENT_USER",
        "HKEY_LOCAL_MACHINE",
        "HKEY_CLASSES_ROOT",
        "HKEY_USERS",
        "HKEY_CURRENT_CONFIG",
    ]
    .iter()
    .any(|key| root.eq_ignore_ascii_case(key))
}
