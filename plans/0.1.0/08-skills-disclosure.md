# 08. Skills progressive disclosure (#222, P1)

**Start from:** `origin/main`. Issue #222 has the full evidence with file:line. Read it first.

## Goal
The model can discover skills, load a skill's instructions, and read the files bundled with it, without loading everything up front.

1. **Level 1: catalog in context.** Each turn gets a compact list of skills, name and one-line description each, in the per-turn context or the session instructions.
   - Put a token cap on the list and truncate descriptions.
   - Resolve duplicate names by precedence: project, then user, then built-in. Today duplicates are appended and both remain (`butler-runtime/src/skills/catalog.rs:186-188`).
   - Cache the catalog keyed by the mtimes of the skill directories. Never rescan per round.
2. **Level 2: load the body.** Add a `load_skill(name)` tool that returns the skill's instructions and a list of its resource files (relative paths only).
   - Make it always visible: add it to the base visibility set (`butler-turn/.../phase/visibility.rs`) and to the catalog profiles (`capabilities/catalog/catalog.json`).
   - Keep `list_skills` for full listings.
3. **Level 3: resources.** Add `read_skill_file(name, relative_path)`.
   - Allow reads only inside that skill's folder. Resolve with the path guard and reject `..`, absolute paths, and symlinks that escape the folder.
   - Enforce a size cap and support windowed reads, like `read_file`.
   - Do not widen `read_file`'s workspace guard (`workspace/path_guard.rs:176-180`).
4. **User invocation.** Let `/skill-name` in the composer load that skill for the turn, if the composer already has slash handling. Otherwise leave it as a follow-up.

## Acceptance
E2E on the stub tier, with a replay cassette:
- The model's first request contains the catalog, including a user skill and a project skill.
- After `load_skill`, the next request contains the body.
- `read_skill_file` returns a bundled file.
- A traversal attempt fails with a clear error. Add a `security`-tagged test only if E2E can't express it.
- For a turn with 50 installed skills, the catalog adds at most 1.5k tokens.
- The catalog doesn't re-read skill files on every round: cache hit.
