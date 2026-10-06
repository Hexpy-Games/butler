# User command hooks

Settings → Hooks manages `$BUTLER_DATA/hooks.json`. No hooks are installed by
default. Hooks run with your privileges and receive full prompt and tool content.
They cannot grant permission or change tool inputs. Project, plugin and HTTP
hooks are not supported yet.

```json
{
  "version": 1,
  "hooks": [{
    "id": "guard",
    "name": "Command guard",
    "event": "PreToolUse",
    "match": {"tools": ["run_command"]},
    "type": "command",
    "args": ["sh", "/absolute/path/guard.sh"],
    "timeout_ms": 30000,
    "failClosed": false,
    "enabled": true
  }]
}
```

Choose `command` (the platform login shell) or `args` (executable and literal
arguments). Optional `env` contains literal environment additions. Only the tool
environment allowlist is inherited; gateway tokens, provider credentials and
`BUTLER_DATA` are excluded. `${BUTLER_PROJECT_DIR}` in argv expands to the bound
project root. Working directory is the project root, otherwise your home.

Events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`
and `SubagentStop`. Tool matchers accept exact names or one trailing `*`.
The JSON stdin envelope uses `schema: "butler.hook.v1"`, `hook_event_name`, stable
`event_id`, timestamp, session/turn/parent identities, project/cwd, access mode,
and `hook: {id, scope: "user"}`. Session creation includes `source`; prompt
submission includes `prompt` and attachment name/media type/bytes. Tool events
include full `tool_input`, call id and `resumed`; post events include `ok`, full
`tool_response` and error details. Stop events include the full last answer and
`stop_hook_active` after a hook-requested continuation.

Exit 2 or `{"decision":"deny","reason":"..."}` denies a pre-event. `block` and
Claude Code's `hookSpecificOutput.permissionDecision: "deny"` are also accepted.
Exit 0 with empty/non-JSON stdout continues. Other exits, crashes, invalid JSON,
spawn failures, timeout and output overflow are logged and continue by default;
`failClosed: true` blocks on these failures. `allow` and `ask` are logged as
`approval_ignored`; normal permission checks still run. Input rewriting and
context injection are ignored. Reasons are limited to 16 KiB.

A tool denial becomes model feedback with code `hook_denied`. A Stop denial uses
the existing continuation budget. A rejected send returns `422 hook_blocked` and
keeps the composer draft. Observe events cannot block.

Sync timeout defaults to 30 seconds, capped at 120; observe-only `async: true`
defaults to 60 seconds, capped at 600. Matching sync handlers run concurrently,
then background handlers use a pool of eight. Identical handlers deduplicate.
Timeout and cancellation terminate the process tree, allow two seconds of grace,
then force termination and reap. Each output stream is capped at 64 KiB; overflow
is an error, never truncated success. Stdin is streamed in full.

Windows `command` uses `cmd.exe /d /s /c`. For PowerShell use
`args: ["pwsh", "-NoProfile", "-File", "C:\\path\\hook.ps1"]`. PowerShell 5
scripts should set `[Console]::InputEncoding = [System.Text.Encoding]::UTF8`.

The file is limited to 256 KiB, 64 hooks and 16 hooks per event. Invalid edits
retain the previous active registry and show an error in Settings. Butler checks
file metadata on session creation and send and reads only changed files; UI saves
publish immediately. There are no hook workers, timers or writes when disabled.
Recent runs are an in-memory ring of 200 entries, cleared on restart, with up to
4 KiB of each output stream for diagnostics. Test runs use a synthetic payload
and do not touch sessions. Configuration and tests require the local app's admin
credential. Saves reject stale revisions with 409.
