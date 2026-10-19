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
        .envs(butler_platform::process_control::fixture_profile_environment(home))
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

impl super::Launch {
    /// Removes a variable from every child command, including harness defaults.
    pub fn unset_env(&mut self, key: &str) {
        self.unset_env.push(key.to_owned());
    }

    /// A command for `program` (an installed Agent, or its launcher) with the
    /// scenario's isolated environment and no installation options.
    pub fn env_command(&self, program: &Path) -> Command {
        let mut command = isolated_command(program, &self.home);
        command
            .env("CODEX_HOME", self.home.join(".codex"))
            .env("TMPDIR", &self.tmp)
            .env("LANG", "en_US.UTF-8")
            .env("TZ", "UTC")
            .env("BUTLER_DATA", &self.data)
            .env("BUTLER_APP_SERVER_HOST", "127.0.0.1")
            .env("BUTLER_APP_SERVER_PORT", self.port.to_string())
            .env("BUTLER_METRICS_ENABLED", "0")
            // launchd and the systemd user manager belong to the user, not to
            // this sandbox: no scenario reaches them unless it turns them on
            // (`set_env("BUTLER_SERVICE_MANAGER", "on")`).
            .env("BUTLER_SERVICE_MANAGER", "off")
            // API keys go to the owner-only file in the data dir: a scenario
            // never touches the machine's credential store (#217).
            .env("BUTLER_SECRET_STORE", "file");
        // What a program needs to start at all (none on Unix), and the
        // Windows temporary folder.
        for name in butler_platform::process_control::SYSTEM_ENVIRONMENT {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        if !butler_platform::process_control::SYSTEM_ENVIRONMENT.is_empty() {
            command.env("TEMP", &self.tmp).env("TMP", &self.tmp);
        }
        for (key, value) in &self.env {
            command.env(key, value);
        }
        for key in &self.unset_env {
            command.env_remove(key);
        }
        command
    }
}
