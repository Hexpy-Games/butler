---
name: butler-model
description: "View or change the AI model used by butler or workers. Supports canonical provider/model refs."
user-invocable: true
applicability: Use when the model decides the user is asking to inspect or change Butler or worker model settings.
allowed-tools: model_set
dispatch: none
review: none
reporting: Reply directly with the current or changed model settings.
---

## Instructions
Call the `model_set` MCP tool based on user intent:
- "butler-model" or "/butler-model" with no args → model_set() — query both butler and worker models
- "butler-model worker openai/gpt-5-codex" → model_set(target="worker", model="openai/gpt-5-codex")
- "butler-model butler openai/gpt-5.6-sol" → model_set(target="butler", model="openai/gpt-5.6-sol") — applies on next restart
- "butler-model list" → model_set(action="list") — show all available models

Reply directly with the result. Do not dispatch a worker.
