---
name: restart
description: Restart the owned native Butler service
user-invocable: true
applicability: Use when the model decides the user is asking to restart the Butler system or one of its runtime processes.
allowed-tools: tool_search tool_call
dispatch: none
review: none
reporting: Report a durable request as pending, never as a completed restart.
---

## Instructions
In a full-access App Turn with an accepted Work Plan that marks this persistent effect, discover and call the registered `request_service_restart` native tool with `{}`. Its result is only `requested: true, status: pending`; the service may hand off the restart only after this Turn's final response is durably delivered. Report the pending request honestly and finish the Turn. Never run the external `restart` command from this same service Turn because its shutdown would wait for the Turn to finish.

If that tool or authority is unavailable, explain that the installed native executable's external `restart` command can be run after this Turn ends, from a terminal or through the MCP `restart_butler` tool. The App and the CLI both control the one service of a data folder: a restart is recorded as intended, so the App does not treat it as a crash. A service the App runs is started again by the App with its own settings; the App reconnects to the restarted service by itself. The command reports success only once the new service is ready. Do not resolve an unrelated `butler` from `PATH`, use a source-tree script, Bun, `BUTLER_HOME`, or process-name kill. Do not claim that a restart was triggered unless the native tool actually returned a durable pending request.

A restart briefly interrupts running work. If the user asks to stop Butler instead, say that `stop` keeps the service stopped, schedules included, until it is started again with `start` or from the App.
Do not dispatch a worker.
