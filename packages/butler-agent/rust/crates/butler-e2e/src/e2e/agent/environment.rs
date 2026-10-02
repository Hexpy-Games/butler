use std::path::Path;
use std::process::Command;

pub(super) fn isolated_command(program: &Path, home: &Path) -> Command {
    let mut command = Command::new(program);
    // The user's shell directory is independent of BUTLER_DATA. Keep the
    // private working directory short: Windows CreateProcess rejects long CWDs
    // even though the agent can read and write a long data directory.
    command.current_dir(home).env_clear();
    command
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env("XDG_STATE_HOME", home.join(".local/state"));
    command
}
