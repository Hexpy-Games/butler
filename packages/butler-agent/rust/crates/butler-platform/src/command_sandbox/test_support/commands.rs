//! Native command fixtures; no POSIX shell or signal emulation on Windows.

use std::collections::HashMap;
use std::path::Path;

use super::{Invocation, POSIX_SHELL};

/// Run a fixture through the native shell with profiles disabled on Windows.
pub fn shell(command: &str) -> Invocation {
    let invocation = super::shell::login_shell(command, &HashMap::new());
    let (Some(program), Some(script)) = (&invocation.shell_program, &invocation.shell_script)
    else {
        return invocation;
    };
    // Structured CommandStep carries only program/arguments. Do not return
    // the interactive wrapper, which also needs its environment transport.
    use base64::{Engine, engine::general_purpose::STANDARD};
    let encoded = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    Invocation {
        program: program.clone(),
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
    }
}

/// Write the three UTF-8 bytes of a euro sign across two flushed writes.
pub fn utf8_fragments() -> &'static str {
    if POSIX_SHELL {
        "printf '\\342'; sleep 0.02; printf '\\202\\254'"
    } else {
        "$out = [Console]::OpenStandardOutput(); $out.WriteByte(0xe2); $out.Flush(); \
         [Threading.Thread]::Sleep(20); $out.WriteByte(0x82); $out.WriteByte(0xac); $out.Flush()"
    }
}

/// Keep the child alive until the command owner terminates it.
pub fn wait() -> &'static str {
    if POSIX_SHELL {
        "while :; do sleep 1; done"
    } else {
        "while ($true) { [Threading.Thread]::Sleep(1000) }"
    }
}

/// Emit capture data before blocking, so a failed writer must stop the child.
pub fn write_then_wait() -> &'static str {
    if POSIX_SHELL {
        "printf x; sleep 5"
    } else {
        // Fill the Windows decoder's 64-byte encoding sniff prefix so the
        // capture sink is written before EOF. cmd emits before PowerShell starts.
        "cmd /d /c echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx& \
         powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"[Threading.Thread]::Sleep(5000)\""
    }
}

/// Finish with an exact one-byte marker after the submitting future is dropped.
pub fn delayed_marker(path: &Path) -> String {
    let path = quote(path);
    if POSIX_SHELL {
        format!("sleep 0.05; printf x > {path}")
    } else {
        format!("[Threading.Thread]::Sleep(50); [IO.File]::WriteAllBytes({path}, [byte[]]@(120))")
    }
}

/// A live descendant publishes its pid atomically before pipeline startup resumes.
/// Unix ignores TERM so cleanup must kill the descendant after its parent exits.
/// Windows has no TERM handler: closing the containing Job Object must kill both.
pub fn descendant(pid_path: &Path) -> String {
    let path = quote(pid_path);
    if POSIX_SHELL {
        format!(
            "sh -c 'trap \"\" TERM; echo $$ > \"$0.tmp\"; mv \"$0.tmp\" \"$0\"; exec sleep 10' {path} & \
             trap 'exit 0' TERM; wait"
        )
    } else {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let child = format!(
            "$path = {path}; [IO.File]::WriteAllText($path + '.tmp', [string]$PID); \
             [IO.File]::Move($path + '.tmp', $path); [Threading.Thread]::Sleep(10000)"
        );
        let encoded = STANDARD.encode(
            child
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        format!(
            "$start = [Diagnostics.ProcessStartInfo]::new(); \
             $start.FileName = $PSHOME + '\\powershell.exe'; $start.UseShellExecute = $false; \
             $start.CreateNoWindow = $true; \
             $start.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}'; \
             $child = [Diagnostics.Process]::Start($start); $child.WaitForExit()"
        )
    }
}

fn quote(path: &Path) -> String {
    let path = path.to_string_lossy();
    if POSIX_SHELL {
        format!("'{}'", path.replace('\'', "'\"'\"'"))
    } else {
        format!("'{}'", path.replace('\'', "''"))
    }
}
