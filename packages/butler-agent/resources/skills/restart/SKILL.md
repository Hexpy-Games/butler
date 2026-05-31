---
name: restart
description: Restart the butler system (orchestrator process, MCP server)
user-invocable: true
applicability: Use when the model decides the user is asking to restart the Butler system or one of its runtime processes.
allowed-tools: restart-butler
dispatch: none
review: none
reporting: Confirm the restart command was triggered.
---

## Instructions
Run the restart script at packages/butler-agent/scripts/restart-butler.sh in the Butler project root ($BUTLER_HOME).
Reply "Restarting now" to the user after running the script.
Do not dispatch a worker.
