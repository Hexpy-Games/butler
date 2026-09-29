# 11. Windows preview merge (#304, P2)

**Start from:** #304, rebased onto main after plan 03 (#303) has merged.

## Steps
1. Rebase onto main and resolve conflicts with #303 in these files:
   - `cli_launcher.rs`
   - `butler-platform/src/lib.rs`
   - `user_dirs.rs`
   - `secure_fs/windows.rs`
   - `os-specific-baseline.txt`
   - `Cargo.lock`

   Adopt #303's `command_launcher`, `install_link` and `user_dirs::agent_home`, and delete #304's duplicate `launcher::LauncherTarget` script type.
2. Switch #303's new `.canonicalize()` calls to the Windows-safe helper: `same_path`, `uses_version`, `AgentHome::contains`, `purge_allowed` and `protected_executables`.
3. Keep `butler-e2e/src/e2e/agent.rs` at 500 lines or fewer.
4. CI: the full macOS, Linux and Windows suite is green.

## Out of scope (post-0.1.0, see plans/post-0.1.0)
- Task Scheduler
- `butler.exe` shim
- PowerShell installer
- read-only command sandbox
