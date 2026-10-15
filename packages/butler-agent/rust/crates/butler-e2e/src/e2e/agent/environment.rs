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
        .env(
            "BUTLER_TEST_SECRET_STORE",
            home.parent()
                .unwrap_or(home)
                .join("tmp/test-secrets/store.json"),
        )
        // Browser import reads the account folders from the OS, not HOME;
        // test-support agents read fixture profiles here instead.
        .env("BUTLER_BROWSER_PROFILES_HOME", home)
        // Other AI agents' setup files come from the same fixture home.
        .env(butler_platform::agent_homes::HOME_FIXTURE, home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env("XDG_STATE_HOME", home.join(".local/state"))
        // Only headless-browser scenarios start (and download) Chromium.
        .env("BUTLER_BROWSER_HEADLESS", "off")
        // Never the machine's installed App: hidden-host scenarios name the
        // in-worktree Electron.
        .env("BUTLER_BROWSER_APP", "off");
    for name in [
        "BUTLER_TEST_SANDBOX_FORCE_L",
        "BUTLER_DEBUG_COMMAND_TIMINGS",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
}
