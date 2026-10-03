# Built-in skills audit

Investigation only, 2026-10-03. Source baseline: `origin/main` / HEAD
`10b68356da71fafdd3c5551ef7cb62d51ee35da3`, branch `codex/builtin-skills-audit`.
`git ls-remote origin refs/heads/main` confirmed the same remote revision.
No product code, skills, budgets, fixtures, or user data were changed.

## Finding and inventory

All nine directories under `packages/butler-agent/resources/skills/` ship as
product resources, including a Butler contributor workflow and a repository-only
compatibility pointer. There is no separate hard-coded core name registry or
first-run copy of these skills into DATA in current main. The filesystem catalog
is the registry (`crates/butler-runtime/src/skills/catalog.rs:46,109,379`).

In the table, **R** means `packages/butler-agent/resources/skills/`; **all** means
every product packaging route in the next section. Model/UI visibility is for
a fresh install without overrides. Cost is `o200k_base` ordinary-text token count:
one compact catalog line / the trimmed body returned by `load_skill`. It excludes
JSON wrapping, metadata from `list_skills`, resources, and tool schemas. Bodies
are loaded on demand, not injected into every initial prompt. Last change is the
last path-changing commit; it is not a claim that every line was authored then.

| Name | Source (`SKILL.md`) | Ships | Audience | Model / Settings | Tokens: line / body | Last meaningful path change | Recommendation |
|---|---|---|---|---|---:|---|---|
| butler-model | R`model/SKILL.md` | all | End user | yes / yes | 22 / 154 | 2026-07-11 `6b0003fa5`, model defaults | Keep core; correct tool availability and examples |
| persona | R`persona/SKILL.md` | all | End user | yes / yes | 14 / 268 | 2026-09-26 `f1173515c`, native cutover | Keep core |
| project | R`project/SKILL.md` | all | End user | yes / yes | 15 / 41 | 2026-05-31 `40d350157`, initial import | Keep core; correct tool availability |
| project-ledger | R`project-ledger/SKILL.md` + `bin/project-ledger` | all | Butler developers; obsolete compatibility | yes / yes, despite non-invocable | 14 / 120 | 2026-05-31 `40d350157`, initial import | Delete bundled pointer and shim; retain canonical tooling |
| restart | R`restart/SKILL.md` | all | End user / service control | yes / yes | 10 / 316 | 2026-09-28 `ea0cd79b6`, restart ownership | Keep core; preserve pending-result/authority rules |
| save-feedback | R`save-feedback/SKILL.md` | all | End user | yes / yes | 20 / 1393 | 2026-05-31 `40d350157`, initial import | Keep core; replace obsolete file-write recipe |
| butler-ship-feature | R`ship-feature/SKILL.md` | all | Butler developers only | yes / yes, despite non-invocable | 23 / 635 | 2026-09-26 `f1173515c`, native cutover | Move to contributor tooling only |
| status | R`status/SKILL.md` | all | End user / runtime diagnostics | yes / yes | 17 / 191 | 2026-09-26 `f1173515c`, native cutover | Keep core; installation-bound commands are intentional |
| wallpaper-authoring | R`wallpaper-authoring/SKILL.md` | all | End user customization | yes / yes | 23 / 3347 | 2026-09-29 `00461a7ce`, safe replacement | Optional catalog candidate; keep until installation exists |

No default skill exists solely for an invisible internal runtime consumer.
`user-invocable` affects the Settings icon and MCP's “internal” marker, not catalog
inclusion (`SkillGroup.tsx:25`, `host/mcp/skills.rs:25`). Hiding rows alone would
leave the same model instructions and packaged resources.

Other repository skills are **not product defaults**:

| Name | Source | Delivery / audience | Product model / Settings | Default prompt cost | Last path change | Recommendation |
|---|---|---|---|---:|---|---|
| project-ledger (canonical) | `packages/project-ledger/SKILL.md` | Explicit CLI `install-skill --target`; project tooling, portable beyond Butler | no / no unless imported | 0 | 2026-09-13 `5236f7e3e` | Keep outside product resources; adapted optional catalog entry only with native tools |
| butler-design-system | `packages/butler-app/client/ui/src/libs/design-system/skills/butler-design-system/SKILL.md` | Explicit contributor install script; Butler UI developers | no / no unless imported | 0 | 2026-10-01 `054af6f80` | Keep developer-only |
| butler-docs-writing | `packages/butler-site/skills/butler-docs-writing/SKILL.md` | Repo skill; Butler documentation contributors | no / no unless imported | 0 | 2026-10-01 `1c5c90848` | Keep developer-only |

These explicit installers are not npm install hooks or first-run seeding.
Persona templates, `resources/eol.md`, and the four `resources/prompts/*.md`
files are prompt assets, not additional SKILL.md catalog entries.

## Packaging and visibility evidence

- macOS App: `client/electron/scripts/prepare-native-agent.mjs:72-85` replaces
  the staged payload and recursively copies the entire agent resource directory.
  `client/electron/package.json:11` packages it with `--extra-resource` at
  `Butler.app/Contents/Resources/bundled-agent/resources/skills/`.
- Linux App: the same preparation and `package.json:13` put it at
  `resources/bundled-agent/resources/skills/`. Release packages wrap this tree
  (`scripts/release/package-linux-app.ts`); no skill allowlist is applied.
- Windows App/installer: `package.json:12` uses the same full copy. The portable
  package and Squirrel installer wrap that App directory
  (`scripts/windows/package-release.ts:20-35`,
  `client/electron/scripts/create-windows-installer.mjs:111-128`).
- Standalone macOS arm64/Linux x64/arm64: prepared resources are copied wholesale
  into `resources/` in the tar archive
  (`rust/scripts/package-standalone-agent.py:78`). Windows x64 ZIP copies the
  input resources likewise (`rust/scripts/package-windows-agent.py:54`).
  The installers activate versioned payloads and bind the native resource root
  (`deploy/install.sh:172-190`, `deploy/install.ps1:58-72,170`).
- npm `@hexpygames/butler` carries installer scripts, not SKILL.md resources
  (`packages/butler-npm/package.json:12-18`). `bin/butler-install.js:27-43` invokes
  those scripts to obtain the matching standalone archive, so its installed agent
  receives the same nine defaults. Packaging hashes/manifests change on removal.
- `host/runtime/skills_owner.rs:17` binds the installed resource root.
  `skills/catalog.rs:46-63` loads project > user > core and deduplicates by name;
  project/user names can override a core name. Settings separately returns all
  three scopes, without deduplication (`catalog.rs:109-137`).
- `skills.rs:62-86` adds names plus the first 72 description characters to the
  prompt, capped at 1400 UTF-8 bytes. `host/guided/factory.rs:265` supplies that
  catalog to the provider prompt. `list_skills` returns metadata, and a named
  call or `load_skill` returns the body. Installed `status` additionally returns
  its body and native commands even on an unnamed `list_skills` call.
- `/skills` exposes the Settings list (`gateway/http/skills.rs:17`).
  `SkillGroup.tsx:26-27` renders raw `name` and English `description`; group labels
  are localized, individual core names are not. MCP `skill_list` and native
  `butler skills list` also expose core entries. Packaging was traced statically;
  no release artifact or owner's installed data was inspected.

## Description, language, and contract quality

- `ship-feature` explicitly names Butler repo/Codex workflow, mandatory spec and
  phase commits. It is neither a general user skill nor current contributor
  policy: its suggested unisolated tests contradict AGENTS.md and its blanket
  unit/integration testing language predates the E2E-first policy. Move it out
  of product resources and reconcile it with current repo rules before installing
  it for contributors; do not copy its obsolete loop unchanged.
- Bundled `project-ledger` is a compatibility pointer to
  `packages/project-ledger/`, which is not in the native resource payload.
  Its Node shim imports repository JS outside the shipped tree. Delete only this
  bundled pointer/shim; retain the canonical package and native Ledger ownership.
- `save-feedback` frontmatter advertises `update_explicit_memory`, while its body
  instructs Write/Edit and manual `$BUTLER_DATA/memory/rules` indexes. The current
  native tool owns canonical authorship and expects `kind: rule`, `text`, `source`
  (`host/guided/tools/memory_write.rs:83-129`). Replace the body with a short
  English tool recipe and truthful confirmation. Remove Korean hard-coded prompts,
  casual Korean copy, emoji warnings, mental SHA hashing, and old storage paths.
- `butler-model` and `project` reference `model_set` and `project_list`, which
  exist on the external MCP server (`host/mcp/server.rs:246,290`) but are absent
  from the Guided raw tool definitions. Keep the end-user intent, describe which
  surface actually supports it, and fall back to App settings/project UI instead
  of promising an unavailable executor. Avoid pinning old model IDs or an
  unverified blanket “next restart” claim. No new tool should be added just for
  this cleanup.
- `persona` honestly points to the Profile-owned personalization UI; `restart`
  correctly distinguishes a pending durable request from a completed restart;
  `status` uses installation-bound commands. Keep these boundaries.
- `wallpaper-authoring` is useful to end users, not Butler repo development.
  Optional distribution is a product choice, not a prerequisite for this fix;
  on-demand loading already avoids injecting its 3347-token body by default.
  English instructions with `{en,ko}` module labels are appropriate localization
  data; Korean quoted trigger examples are data, not a reason to delete a skill.
- Search of bundled skills and canonical Ledger instructions found no Telegram,
  Box, “automation,” or “Steward” references. Resource prompts are English and
  likewise have no Telegram/Box/automation copy. `prompts/steward.md` is active
  role material (`context/prompt/sections.rs:43`), not an obsolete skill. Keep
  internal role identifiers; prohibit leaking “Steward” into ordinary user replies
  if prompt copy is edited. Do not delete an active role prompt as skill cleanup.
- Preserve English machine names/descriptions/instructions. Add localized core
  display names in existing App copy, keyed by stable skill ID, e.g. 모델, 페르소나,
  프로젝트, 재시작, 피드백 저장, 상태, 배경화면 만들기. Unknown user skill IDs keep
  their authored name. Use “schedule” / “예약 작업” for visible scheduling copy.

## Token measurements and ratchets

Measurements recreate current frontmatter parsing, alphabetical name order,
whitespace normalization, 72-character descriptions, and the exact catalog header.
Python `tiktoken` / `o200k_base` matches the Rust tokenizer selected by
`butler-models/src/models/tokenizer.rs`; no provider/model call was made.

| Fresh default catalog | UTF-8 bytes | Tokens | Reduction from current |
|---|---:|---:|---:|
| Current 9 | 803 | 167 | — |
| Minimal: remove ship-feature and bundled Ledger | 628 | 130 | 175 bytes; 37 tokens (22.2%) |
| Later: also make wallpaper optional | 532 | 107 | 271 bytes; 60 tokens (35.9%) |

The two removed bodies total 755 tokens **only when individually loaded**;
they are not another 755 tokens saved per initial request. Full prompt/provider
billing deltas are unmeasured, and counts are not additive across JSON boundaries.
With many user/project skills, freed catalog space may admit later entries, so
the 37-token reduction is guaranteed only for this fresh default fixture.

Current main has a 1400-byte catalog cap asserted in
`butler-e2e/tests/skills_disclosure.rs:109-114`, not a persisted numeric
prompt-token ratchet. The plan mirror `plans/0.1.0/08-skills-disclosure.md:27`
states 1.5k tokens for 50 skills. `agent_context.rs:20,260-329` measures real
provider requests with o200k but does not impose a numeric maximum. Do not claim
that a nonexistent ratchet was lowered. Add a fresh-default E2E expectation at
130 tokens for the removal-only revision, or the newly measured lower value after
English copy edits; never raise the 1400-byte cap or truncate more content.
Preserve large-catalog discovery via `list_skills`. `source-check-tests.txt`
is the separate non-E2E test-count ratchet and should remain unchanged.

## Removal side effects and migration

- `skills_disclosure.rs` / cassette `SKILL-222/{000,004}.json` use synthetic
  `project-guide` / `user-guide`, not the two removed core names. They verify
  shadowing, progressive load, resource paths, cache behavior, and traversal
  rejection. No cassette literal matching the five searched product names
  (`butler-ship-feature`, `project-ledger`, `save-feedback`, `wallpaper-authoring`,
  `butler-model`) was found. Still run replay: prompt construction changes, and
  absence of name literals alone is not proof of replay compatibility.
- Preserve E2Es in `durable_files.rs` (import/reopen/security/concurrent replace),
  `cli_surface.rs:123,163` (native import/list), and `agent_context.rs` (fresh and
  large profile requests). Existing `skills/tests.rs` and gateway
  `application/tests/skills.rs` cover native command binding and loaded-skill
  transcript projection; historical loaded names must remain readable.
- `tests/unit/project-ledger-skill.test.ts` covers the canonical package skill,
  not the bundled pointer. Keep it and its installer intact. Existing site skill
  docs describe three scopes rather than guaranteeing all nine product defaults.
- Current first-run seeding calls Profile defaults (`host/runtime/defaults.rs:147`),
  not skill copy. New/updated immutable resource trees naturally omit removed
  core directories. Old versioned payloads can remain for installer rollback;
  do not edit live bundles, old versions, transcripts, or DATA in-place.
- User/project copies under DATA can be authored, edited, or explicitly imported,
  even with the same names. Current files have no seed-provenance manifest.
  **Leave all such copies intact**, including unknown legacy “seeded” copies.
  Never delete by name or body resemblance. Automatic removal of a historical
  seed is acceptable only with proven installer ownership plus the exact original
  tree hash; preserve any edited/copied tree. No such provenance was established
  in this task, so the minimal proposal needs no DATA migration or scan.

## Minimal implementation proposal (not executed)

1. Move/reconcile `resources/skills/ship-feature/SKILL.md` into repo contributor
   tooling, preferably `.codex/skills/butler-ship-feature/SKILL.md` with one
   canonical copy. Delete `resources/skills/project-ledger/` pointer and shim.
   All platform payloads already copy the same resource tree: no per-platform
   filters, parallel registry, installer blacklist, or new platform code needed.
2. In the existing skill E2E surface, assert fresh `/skills` core names, prompt
   absence, `load_skill` not-found for removed names, restart/reopen stability,
   and preservation of same-named user/project overrides. Measure the complete
   fresh provider catalog, all expected names/order and tokenizer cost together.
   Reuse existing fixture/import paths; no added implementation-mirroring unit test.
3. Run stub/replay `skills_disclosure`, applicable `durable_files`, `cli_surface`,
   `agent_context`, existing native-binding/projection tests, and resource package
   smokes. Inspect macOS/Linux payloads and Windows archive/installer contents
   for the same seven core directories; verify manifest hashes regenerate.
   Defer unavailable platform runs explicitly, rather than asserting parity from
   a source-only trace. No live cassette recording is expected.
4. Small follow-on copy patch: `save-feedback`, `model`, `project` skill bodies;
   `SkillGroup.tsx`, `packages/butler-i18n/src/copy-contract.ts` and
   `packages/butler-i18n/src/locales/{en,ko}.ts` for display labels. Run relevant
   memory-write/model/project replay coverage, locale UI harness smoke, and
   `bun install --frozen-lockfile --ignore-scripts && bun run check`. Measure again
   before setting a lower E2E prompt ceiling. Rust changes get fmt, touched-crate
   Clippy `-D warnings`, source-check, and required test-category tags.
5. Optional wallpaper distribution waits for an actual downloadable catalog entry
   and existing ZIP import flow. Do not build a marketplace for this two-directory
   cleanup. Related plugin/catalog design is tracked in issue #472.

Owner decisions: approve the two-directory cleanup; select wallpaper core versus
later optional catalog distribution; confirm leaving unproven DATA copies intact.
The recommendations are removal now, wallpaper unchanged pending catalog, and
preservation of all user/project copies. Nothing in this report authorizes
implementation, deployment, operational restart, or an owner-data inspection.

## Validation and delivery

- `cargo fmt --all -- --check`: passed, isolated HOME/BUTLER_DATA.
- `cargo run -p butler-source-check -- .`: first attempt could not compile because
  the inherited sccache server referenced a removed temp path. With only
  `RUSTC_WRAPPER=''`, the same check passed: zero function-length, platform,
  test-ratchet, architecture, wall-clock, and E2E-gate violations. An xcrun cache
  warning did not prevent compilation or checking. No budget/test was changed.
- Static packaging/catalog/copy/reference audit and isolated token measurement:
  completed. Release build, runtime E2E, and provider invoice measurements were
  not run for this documentation-only task. Clippy has no touched crate; TS/UI
  install/check is inapplicable because no TS/UI file changed.
- `git diff --no-index --check /dev/null <report>`: passed. Temporary measurement
  environment, HOME/DATA directories, and this task's `target/` were deleted.
- Git fetch was denied writing shared `.git/.../FETCH_HEAD`; read-only remote
  revision verification succeeded. Both `git add` and `git commit` were denied
  creating shared `index.lock`. The report remains untracked for the runner to
  commit/push, as authorized by the task's sandbox fallback. No report commit
  exists, so pushing an unchanged baseline was not attempted. HEAD is still
  `10b68356d`; no PR, tag, merge, or CI run was created.
- Open-issue searches found no matching cleanup issue. Created
  [#477](https://github.com/Hexpy-Games/butler/issues/477) and posted the
  [investigation summary](https://github.com/Hexpy-Games/butler/issues/477#issuecomment-5965081425).
