use std::path::Path;
use std::process::Command;

pub(super) fn isolated_command(program: &Path, data: &Path, home: &Path) -> Command {
    let mut command = Command::new(program);
    command.current_dir(data).env_clear();
    command
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env("XDG_STATE_HOME", home.join(".local/state"));
    command
}
