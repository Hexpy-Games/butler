---
name: project
description: List all registered projects with their recent task history and status
user-invocable: true
applicability: Use when the model decides the user is asking to list or inspect registered Butler projects.
allowed-tools: project_list
dispatch: none
review: none
reporting: Reply directly with project names, paths, and recent state.
---

## Instructions
Call the `project_list` MCP tool and format the result as a clean project list.
Show project name, path, and recent task summary.
Reply directly. Do not dispatch a worker.
