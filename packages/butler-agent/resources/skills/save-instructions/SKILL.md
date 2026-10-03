---
name: save-instructions
description: Remember a concrete instruction from the user.
allowed-tools: update_explicit_memory forget_explicit_memory
---

Use update_explicit_memory with kind instruction for clear instructions. duration is this chat, 7 days,
or always (default for lasting intent). Repeating a temporary instruction with
the same meaning in its scope makes it lasting; reuse the saved text. Use replaces
for a correction.
A complaint alone is not an instruction. Infer the requested change only when
intent is clear; otherwise ask one short question. Never save the complaint itself.
Use forget_explicit_memory to withdraw a selected instruction.
