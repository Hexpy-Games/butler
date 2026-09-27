---
name: status
description: Check butler system status including uptime, running tasks, memory info, and worker statistics
user-invocable: true
applicability: Use when the model decides the user is asking for Butler system, task, memory, dashboard, or worker status.
allowed-tools: list_skills, run_command, get_work_dashboard, get_memory_health
dispatch: none
review: none
reporting: Reply with concise canonical status and hide raw ids unless debug is requested.
---

## Instructions
1. Discover this installed skill through `list_skills` and use its installation-bound `native_command` through `run_command` to read native service, Work, and memory status. If a field is unavailable, report it as unavailable rather than inventing a count.

2. Use the returned `native_context_command` through `run_command` for the source-defined injection-file estimate. Do not resolve an unrelated command from `PATH`, invoke Bun, or use a source-tree script.

If `run_command` is not authorized for this Turn, use the available read-only dashboard and memory-health tools, and report the unavailable native/context fields explicitly.

3. Combine both outputs into a single message:
   - Top section: formatted native status summary.
   - `## Context Window` section: native context status facts. Distinguish the static estimate from a live provider prompt token count.

4. Reply to the principal with the combined message.
