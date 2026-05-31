---
name: status
description: Check butler system status including uptime, running tasks, memory info, and worker statistics
user-invocable: true
applicability: Use when the model decides the user is asking for Butler system, task, memory, dashboard, or worker status.
allowed-tools: get_work_dashboard, get_memory_health, list_tasks, get_task_result
dispatch: none
review: none
reporting: Reply with concise canonical status and hide raw ids unless debug is requested.
---

## Instructions
1. Call the `butler_status` MCP tool to get uptime, task counts (running/pending/done/failed), and memory system status.

2. Run `bun run $BUTLER_HOME/packages/butler-agent/scripts/status-context.ts` via Bash to get token usage per injection-file bucket.

3. Combine both outputs into a single message:
   - Top section: formatted butler_status summary.
   - `## Context Window` section: output of status-context.ts.

4. Reply to the principal via Telegram reply tool with the combined message.
