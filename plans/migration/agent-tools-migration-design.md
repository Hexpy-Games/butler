# Migration from other agent tools

Status: research and proposed design, 2026-10-03; no product implementation or runtime measurements.
Owner request: **"타 프로그램에서의 마이그레이션"**.
Issue: [#476](https://github.com/Hexpy-Games/butler/issues/476). Branch: `codex/migration-research`.
Baseline: `10b68356da71fafdd3c5551ef7cb62d51ee35da3`; approved work-model direction: `origin/codex/work-model-design` at `0df4b6203b82922fc77cadd2cd41e7fac79d0b35`, `plans/work-model/work-model-design.md`, §§1–2, 8–10.
Related: [plugins #472](https://github.com/Hexpy-Games/butler/issues/472), [hooks #166](https://github.com/Hexpy-Games/butler/issues/166), [skill/MCP import failures #219](https://github.com/Hexpy-Games/butler/issues/219). None covers this migration feature. Open/closed issues were searched before creating #476.

## 1. Outcome and boundaries

Bring a user's supported setup from **Codex CLI/local app, Claude Code, OpenCode, and Nous Research Hermes Agent** into Butler through one reviewed import action. Detect → preview → import → report is the same operation in desktop and CLI. One-click means one apply after selection and conflict review; it does not mean invisible credential transfer or automatic execution.

**Phase 1 is configuration only:** global/project instruction files (`AGENTS.md`, `CLAUDE.md`, etc.) become Butler **지침**; import skills, custom commands/agents where they map, MCP server configuration, and model/provider preferences. MCP secrets are never copied: the user re-enters them, or Butler retains an opaque source secure-store reference when a supported integration can use one. Memory, session history/transcripts, schedules, hooks/permissions, and all other data are deferred to later phases.

Hermes is verified as [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), linked by its [official documentation index](https://hermes-agent.nousresearch.com/docs/llms.txt). It is not the Hermes model family, Hermes JavaScript engine, or another similarly named agent. This is the product explicitly named in the request; no owner clarification is needed.

Goals: preserve instruction scope, supported skill assets, non-secret connection/model metadata, explicit provenance and every selected record's disposition; retain source installations unchanged; make one-way import, interruption recovery and idempotent re-runs predictable; later phases may add memory/history as private reference material.
Non-goals: running source CLIs/plugins, copying credentials/OAuth grants, mirroring a whole home directory, continuous sync, undo/rollback, reproducing foreign sandboxes, resuming foreign agents/tool calls, importing arbitrary provider caches/vector databases, or turning source todos into accepted Butler Tasks. No LLM conversion, network access or embedding calls during detect/preview/apply.

The approved work model remains **Spec → Plan → Work → Tasks**; immutable Spec bodies belong to Ledger and mutable execution state to BTCC SQLite. Migration's transfer receipt is not a Work/Task. A later “continue this work” request goes through the existing tier router: Tier 0 creates no managed records; Tier 1 gets one brief Spec; Tier 2 gets the required tree before delegation. Imported Markdown, completion labels, reviews and permissions confer neither Spec activation nor effect authority. Existing completed Butler Tasks and their evidence are untouched. This is distinct from `codex/work-model-migration`, which migrates Butler's own legacy state.

## 2. Current Butler evidence

`R/` below means `packages/butler-agent/rust/`; `UI/` means `packages/butler-app/client/ui/src/`. References are source observations at the baseline, not runtime verification.

| Existing owner / limitation | File:line and design consequence |
|---|---|
| Explicit rules already have project binding, stable operation ID, content revision and projection notice. No directory/glob scope in the input. | `R/crates/butler-memory/src/cognition/sources/typed/write.rs:25`, `:73`; `cognition/paths.rs:66`. Reuse the owner; add scope/retirement contracts before activating nested rules. Never flatten path-specific instructions globally. |
| Skill precedence is project > user > core, first name wins. | `R/crates/butler-runtime/src/skills/catalog.rs:42`, `:373`. Targets are `skills/default` and `skills/projects/<id>`; namespacing must prevent imported skills shadowing existing/core names. |
| Skill definitions contain executable/native and tool-related fields; archive import exists. | `R/crates/butler-runtime/src/skills/catalog.rs:15`; `skills.rs:203`, `:278`. Reuse validation and blocking-I/O lane; do not feed foreign metadata directly into native dispatch. |
| Personalization supports persona/EOL/profile; existing third-party text import can invoke a model. | `R/crates/butler-agent/src/host/app/runtime_ports/personalization.rs:72`, `:88`; `personalization/paths.rs:25`; `UI/components/settings/PersonalizationProfileMigration.tsx:13`. Extend Settings with a file import entry, preserve the separate text import, never call its extraction path implicitly. |
| EOL is governing runtime instruction, different from persona/profile. | `R/crates/butler-agent/src/host/guided/prompt/documents.rs:193`, `:232`. Foreign instructions never overwrite `eol.md`. |
| MCP registry is global, with transport/command/args/cwd/URL and secret sources; create defaults to enabled. | `R/crates/butler-models/src/mcp_client/registry.rs:32`, `:108`, `:207`; `management.rs:26`, `:49`; gateway `application/mcp_servers.rs:6`. Import must explicitly stage disabled; project restriction/tool filters need enforcement before activation. |
| Model registration and credentials have an existing owner; hosted IDs must be runtime-supported. | `R/crates/butler-models/src/models/configuration/mutations.rs:30`, `:50`, `:60`. Preserve exact model IDs, show unsupported ones, keep current default. |
| OS credential stores and zeroizing secret values already live in the platform crate. | `R/crates/butler-platform/src/secrets.rs:80`, `:167`. Re-enter through credential administration or explicitly bind an existing Butler secret/environment reference. |
| Schedule creation requires a target session and has no initial paused-state field; update accepts state. | `R/crates/butler-gateway/src/gateway/application/automations/contracts.rs:6`, `:22`. Add atomic paused creation to this owner; create-then-pause could accidentally run. |
| Access modes are full access, ask first, read only. | `R/crates/butler-turn/src/btcc/contracts.rs:23`. Foreign globs/approval receipts are not equivalent. Import changes no existing access mode. |
| Canonical conversation storage already has an owner thread and paged readers; historical recovery is for Butler-origin evidence. | `R/crates/butler-turn/src/conversation.rs:53`, `:92`; `conversation/historical_origin.rs:29`; `R/crates/butler-runtime/src/context/conversation/read.rs:49`. Extend that owner with an inert external-archive namespace; do not send foreign rows through Butler's historical-origin classifier. |
| Gateway already provides authenticated event streaming and CLI has skill/schedule owners. | `R/crates/butler-gateway/src/gateway/http/read_routes.rs:112`; `R/crates/butler-agent/src/host/cli.rs:14`. Add typed migration commands and cursor events through these surfaces; no polling or second daemon. |

### 2.1 Local read-only observations

Only allowlisted path presence, directory counts and known config-key presence were inspected in `~/.codex` and `~/.claude`; no values or instruction/skill bodies are reproduced here. No auth files, conversation bodies, private memory bodies or real `~/.butler` were opened for this research. OpenCode/Hermes installation state was not inspected or inferred.

| Root | Structure observed on this machine |
|---|---|
| `~/.codex` | `config.toml`, `AGENTS.md`; `skills/`, `agents/`, `rules/`, `plugins/`, `memories/`, `sessions/`, `archived_sessions/`, `automations/`, `session_index.jsonl`. Known config sections: model, model_providers, mcp_servers, approval_policy, sandbox_mode, projects, features, skills. |
| `~/.claude` | `settings.json`, `CLAUDE.md`; `skills/`, `agents/`, `plugins/`, `sessions/`, `projects/`, `history.jsonl`. Known settings sections: permissions, hooks, model, enabledPlugins. |
| Skill layout counts | Codex: 27 immediate entries, 23 directories resolving to `SKILL.md`, 1 symlink. Claude: 23 entries, 20 such directories, 5 symlinks. These overlapping structural counts are not importable-skill totals. Agent directories contain 1 and 11 immediate entries respectively. |

This proves legacy `~/.codex/skills` and symlinked skills matter here even though current Codex docs emphasize `.agents/skills`. Do not infer effective configuration from presence, inspect secrets to detect login, or descend into all projects/history just to populate the source picker.

## 3. Source formats and migration mapping

Primary references [C1–H7] in §10 were accessed **2026-10-03**. Each adapter records its parser revision and recognized schema, independently of the tool's installed version. Current public docs can describe newer features than a local installation. Unknown schemas get an explicit unsupported result, not a guessed conversion.

### 3.1 Codex CLI and local app

| Category | Source format / resolution | Butler disposition |
|---|---|---|
| Global/project instructions | `$CODEX_HOME` (default `~/.codex`) `AGENTS.override.md` before `AGENTS.md`; repo-root→CWD chain, one override/base/fallback file per directory. `config.toml` can add developer instructions and document fallback names. [C1,C2] | Import as scoped Butler 지침; preserve chain and overridden/inactive provenance. Never append all files into EOL. |
| Skills | User/repo `.agents/skills/<name>/SKILL.md`, resources/scripts and agent metadata; admin/system/plugin scopes also exist. Local legacy `.codex/skills` is present. [C3] | User/project skills with assets and provenance after compatibility review; system/bundled duplicates are excluded by default. Shared physical skill imported once. |
| Commands/agents | Skills are the current reusable-command path; custom agent TOML under user/project `.codex/agents`, with description, instructions, model and sandbox overrides. Older role/config-file layouts and legacy `prompts/*.md` need separate version fixtures. [C4] | Pure prompt → user-invocable skill draft; persona text only if explicitly chosen. Delegation/sandbox/tool directives stay unmapped. Unsupported legacy variants remain visible. |
| MCP | Layered `config.toml` `[mcp_servers.<id>]`: stdio or HTTP, args/cwd, env/header references, tool filters and OAuth metadata. User/provider configuration is not always overridable at project scope. [C1] | Disabled registry draft; preserve exact restrictions or block activation until Butler can enforce them. Reauthorize OAuth. |
| Hooks/permissions (later phase) | `hooks.json` or inline `[hooks]` beside config layers, plugin hooks; older `notify` command. Approval policy, sandbox, trust and exec rules are distinct mechanisms. [C1,C5] | Report only; never run/import hook trust, exec allowlists or sandbox bypass. |
| Models/providers (P1) | `model`, `model_provider`, `model_providers`, reasoning options, current sidecar profile TOML and older inline profiles. [C1] | Import selected non-secret preferences through Butler settings; exact IDs/profile choice, no automatic default switch or credential discovery. |
| Memory (later phase) | Local memories are separate from hosted ChatGPT memory. Machine has `memories/`; Markdown artifacts can include `MEMORY.md`, summary/skill/rollout summaries, version-dependent. [C7; local inventory] | Optional private reference sources; summary/underlying source linkage retained, no automatic promotion to verified rules or profile. Cloud/computer-history data is excluded. |
| Sessions (later phase) | Local JSONL rollouts in sessions/archived sessions; SQLite metadata and newer history storage evolve separately. App-server has paged thread reads but can repair/backfill state. [C6,C8] | Versioned read-only archive adapter; no resume, backfill, state DB transplant or source app-server startup. Local app/CLI share source identity, avoiding duplicate imports. |
| Schedules (later phase) | App supports local/project schedules and RRULE; `automations/` exists here, but its record schema was not inspected and is not promised by the public docs. [C9] | Recognized records may become paused schedule drafts after format fixtures; unknown records and cloud/event triggers are reported for manual setup. |

### 3.2 Claude Code

| Category | Source format / resolution | Butler disposition |
|---|---|---|
| Instructions | `~/.claude/CLAUDE.md`, project `CLAUDE.md`/`.claude/CLAUDE.md`, `CLAUDE.local.md`, nested `.claude/rules/*.md` with path conditions and `@` imports. Current docs also describe AGENTS.md support; do not assume older versions load it. [A1] | Import as scoped Butler 지침; explicit selected include closure, no arbitrary external include reads. Managed instructions remain managed evidence, not user overrides. |
| Skills/commands | `~/.claude/skills` and `.claude/skills`, `SKILL.md` frontmatter; `commands/*.md` legacy prompt commands, plugin-namespaced copies. Dynamic shell substitutions/argument forms can occur. [A2] | Portable skills/assets; pure commands adapted to explicit invocation. Dynamic evaluation, hooks, tool grants and agent context settings are not executed or silently dropped. |
| Agents | User/project `agents/**/*.md`, YAML frontmatter plus prompt; model/tools/permission mode and persistent-memory scope. [A3] | Prompt/role draft, not a new Butler Worker runtime or accepted Task. Persistent agent memories remain distinct sources. |
| MCP | User and local-project entries in mixed `~/.claude.json`; project `.mcp.json` `mcpServers`; managed/plugin definitions also exist. [A4] | Extract only selected MCP config fields; never import sign-in/trust fields. Disabled draft with reauthorization. Do not confuse settings.json with the canonical user MCP store. |
| Hooks/permissions (later phase) | User/project/local settings JSON and managed settings; lifecycle hook matchers with command/prompt/agent/HTTP handlers; allow/ask/deny patterns, sandbox and default permission mode. [A5,A6] | Report exact semantic gaps; no hook execution or permission/enterprise-policy weakening. |
| Models/providers (P1) | Settings `model`, provider-related environment names/endpoints, custom model choices; credentials/helpers may be referenced. [A5] | Import selected non-secret preferences; aliases require owner selection; helpers and environment values are never executed/resolved. |
| Memory (later phase) | `projects/<project>/memory/` (normally shared across worktrees), configurable auto-memory directory; `agent-memory/` and project/local variants. [A1,A3] | Optional reference documents with project/agent provenance. Preserve distinct directories even if titles overlap. |
| Sessions (later phase) | `projects/<project>/<session>.jsonl`, nested subagent transcripts; `history.jsonl` is command/input history, not a substitute for full sessions. `CLAUDE_CONFIG_DIR` changes storage root. [A5,A6] | Optional read-only archive with parent links and tool content as quoted data; never import pending tool calls or treat subagent results as Butler reviews. |
| Schedules (later phase) | Session loops/plugin hooks have different lifetimes and execution semantics from Butler schedules. | No inferred schedules from hooks or text; manual draft only when cadence, timezone, target and action are explicitly available. |

### 3.3 OpenCode

| Category | Source format / resolution | Butler disposition |
|---|---|---|
| Config/instructions | XDG config `opencode/opencode.json[c]`, project `opencode.json[c]`, `.opencode/`; custom path/dir/inline overrides, remote defaults and managed policy. Global `AGENTS.md`, ancestor project AGENTS with CLAUDE fallback; config `instructions` lists local globs/URLs. [O1,O2] | Import local explicit layers as scoped Butler 지침; disclose unknown inline/remote/managed layers. No remote fetch or config JS execution. Preserve scope and references. |
| Skills | `.opencode/skills`, global config skills, compatible `.claude/skills` and `.agents/skills`. Plural directories are current; singular supported for compatibility. [O1,O3] | Deduplicate shared physical sources across all selected tools; supported SKILL.md and assets through Butler Skills. |
| Commands/agents | `commands/*.md`, `agents/*.md` and JSON `command`/`agent`; templates, shell/file expansion, primary/subagent modes and per-agent permissions. [O4,O5] | Pure prompt skills or role drafts; expansion/tool/agent semantics require manual adaptation, never evaluation during preview. |
| MCP (P1)/hooks (later phase) | `mcp` in JSON config (local command array or remote URL/auth); `plugins/*.ts`/`.js` or npm plugins provide lifecycle hooks and custom tools. [O6,O7] | Import selected MCP config disabled. Hooks/plugins are deferred; never execute plugins or install dependencies. |
| Permissions (later phase)/models (P1) | `permission` allow/ask/deny and ordered tool/input patterns; current V2 terminology may differ. Provider/model options are config, auth data is separate. [O1,O8] | Preserve permission policy for later review. Import selected non-secret model/provider preferences; no silent alias substitution. |
| Memory (later phase) | Core conventions provide instruction/skill/session context; no single portable dedicated user-memory schema is established by the reviewed docs. | Do not invent a MEMORY.md contract; opt-in explicit documents supported, third-party memory plugins require separate export. |
| Sessions (later phase) | XDG data (default `~/.local/share/opencode`), old project/storage JSON layouts in docs; pinned current source uses `opencode.db` or channel-specific DB and `OPENCODE_DB`. Public `opencode export` emits JSON. [O9,O10] | Prefer versioned JSON export when supplied; otherwise recognized read-only SQLite or legacy file adapter. Never launch export implicitly: startup code creates directories/migrates storage and can load plugins. |
| Schedules (later phase) | No portable built-in schedule persistence contract established by reviewed core docs. | Plugin timers/CI jobs are unsupported; do not map them to Butler schedules by guessing. |

### 3.4 Nous Research Hermes Agent

| Category | Source format / resolution | Butler disposition |
|---|---|---|
| Home/profiles/instructions (P1) | `HERMES_HOME` defaults `~/.hermes`; named profiles under `profiles/<name>` have isolated config/memory/state. Global `SOUL.md`; project `.hermes.md`/`HERMES.md`, AGENTS overrides/base, CLAUDE and Cursor conventions with priority. [H1,H2] | Explicit profile selection; import plain-text instructions as scoped Butler 지침; do not import persona, agent or delegation behavior that does not map. |
| Skills/commands/agents | `skills/` SKILL.md bundles, categories and hub/bundled metadata; plugins can register commands and skills. Named profiles/bots and delegation config differ from Markdown agent definitions. [H3,H4] | Portable skill bundles; static prompt/persona drafts. Plugin command handlers, bot routing and delegation topology do not become Butler agents. |
| MCP | `config.yaml` `mcp_servers`, command/args or URL, env/headers, include/exclude tool sets, resource/prompt toggles and optional TLS material. [H1,H5] | Disabled drafts; retain every restriction. Unsupported TLS/OAuth/helper/filters require reconfiguration before enable. Never copy certificates/private keys. |
| Hooks/permissions (later phase) | User `plugins/<name>/plugin.yaml` plus Python hooks; optional project plugins. `command_allowlist`, approvals deny/unattended policy, toolsets and terminal backend settings. [H4,H6] | Report-only for executable hooks/backends and grants. No Python import, plugin install, gateway access list or container/SSH transfer. |
| Models/providers (P1) | YAML model (legacy scalar or mapping), provider/default/base URL, auxiliary/fallback/delegation slots; `.env` and external secret providers are separate. [H1] | Import selected non-secret preferences; unsupported slots remain visible. No provider login/token portability assumed. |
| Memory (later phase) | `memories/MEMORY.md`, `USER.md`; optional external memory providers. [H2,H7] | Optional private source documents; USER is profile evidence, not an unquestioned identity update. External provider databases/embeddings excluded. |
| Sessions (later phase) | Profile-local `state.db` stores sessions/messages with FTS; session export/storage versions can differ. [H7] | Consistent read-only snapshot → private archive; no copying whole DB, FTS index, provider state or resumable tool state. |
| Schedules (later phase) | `cron/jobs.json`, prompt/cadence/skills/delivery and execution metadata. [H8] | Supported cadence/timezone → atomic paused schedule only after choosing a Butler target. Delivery credentials, execution receipts and script-only jobs are unmapped. Never catch up past runs. |

### 3.5 Destination rules shared by all adapters

| Destination | Contract and fidelity boundary |
|---|---|
| Rules/instructions | Preserve global/project/directory conditions, order, inactive overrides and source links. Extend the existing explicit-rule owner with typed applicability and previewed text approval; source-derived rules remain subordinate to Butler policy/EOL. Unrepresentable glob/include semantics stay draft, never broaden to global. |
| Skills/commands | Namespace as `<source>-<name>` (stable suffix on collisions), retain scope and complete permitted assets/relative links. Validate frontmatter and licenses. Foreign tool names, native command fields, shell substitutions and absent dependencies yield `needs_review` with exact omissions; never report an executable-compatible import when only the prompt survived. |
| MCP | Explicit `enabled=false`, source scope/filter contract retained. Global target cannot activate project-only server until scope enforcement exists. No probe/connect/install during import. Activation uses existing settings/effect controls after secret binding. |
| Models/providers | Phase 1 imports selected non-secret preferences through existing settings owners. Unsupported IDs remain visible; no silent alias substitution, provider probe, or credential copy. Existing Butler values use the conflict flow below. |
| Personas, approvals/hooks | Later phase. Permanent approvals, trust hashes and sandbox bypass are never transferred; hooks are not schedules. Preserve restrictions and require equivalent enforcement before any later activation. |
| Schedules | Calendar subset only, exact timezone/DST/cadence and prompt/skill dependencies; target session must be chosen. Atomic paused creation with explicit access mode no broader than current policy. Enable is a separate normal schedule action; no foreign delivery or run history replay. |
| Memory/history | Later phase; opt-in, source-tagged private reference archive; no automatic recall/profile ingestion or model disclosure. A separate explicit selection can publish compatible documents through the memory source owner. Retain full selected content or report excluded/unsupported parts; no silent truncation/LLM summarization. |
| Work model | Historical source session/task/parent IDs are archive provenance only. Start fresh Butler execution from a selected reference via normal router/Spec authoring. Never synthesize accepted reviews, completed Tasks, leases, queue entries or grants. |

## 4. Alternatives and recommendation

| Option / prior art | Benefit | Cost / decision |
|---|---|---|
| Copy tool home wholesale | Superficially simple; byte preservation | Copies credentials, incompatible state and executables; rejects scoped, one-way import. Reject. |
| Ask a model to translate everything | Handles freeform instructions; existing Butler profile import | Disclosure, cost, nondeterminism, lost policy semantics. Optional later authoring only with explicit consent, outside migration. |
| Launch source export/app-server | Public projections can avoid DB coupling | Startup can write/backfill and activate plugins; unavailable/uninstalled tools break detection. Accept owner-supplied exports, do not run tools implicitly. |
| Versioned local adapters → reviewed typed items | Offline preview, predictable omissions, stable IDs, no source modification | More format fixtures and explicit unsupported states. **Recommend**; adapter remains small and data-only. |
| Live links or automatic sync | Minimal copying / always-current setup | Source changes can silently change instruction authority, break links, or trigger idle work. Use immutable approved snapshots and explicit re-run. |

Codex's [import flow](https://learn.chatgpt.com/docs/import) demonstrates source/item selection, unchanged sources and connection follow-up; its recent-chat cap is not a Butler completeness policy. Hermes [import-agent](https://hermes-agent.nousresearch.com/docs/user-guide/import-from-other-agents) demonstrates dry-run, conflict handling, digest-based re-run and credential exclusion. Butler adopts those useful mechanics, but does not translate shell allowlists into authority, move all instructions into memory, or schedule sync. OpenCode's [export](https://opencode.ai/docs/cli/#export) is a useful interchange fallback; its sanitize option redacts transcript content, so import must identify a sanitized archive instead of claiming complete original conversations.

## 5. Desktop and CLI behavior

1. Settings → **“가져오기”** / “Import”. Sources show `감지됨`, `없음`, `접근 불가`, `확인 필요` separately. Detect only explicit roots/known conventional locations and selected project folders; a directory means “data found”, not “installed and authenticated”. Allow a folder/export picker and named profile selection. Never crawl the whole home or auto-select every historical project.
2. Preview lists only phase-1 configuration: 지침, skills, mappable commands/agents, MCP and model/provider preferences. Show the exact selected items, source and destination scope, disposition, dependencies, secret setup and conflicts. Memory, sessions/transcripts, schedules, hooks/permissions and other data stay out of phase 1. Unsafe, incomplete or unmappable items are unselected; one bad file does not hide good items.
3. Conflicts: **“건너뛰기”** / “Skip”, **“둘 다 유지”** / “Keep both”, **“교체”** / “Replace”. Default is Skip; existing user-created Butler data is never overwritten by default. Keep both previews the collision-free Butler identity. Replace requires an explicit per-item choice and displayed destination revision. Identical content/scope is `unchanged`; project folders must be explicitly mapped to a Butler project.
4. **“가져오기”** applies the shown selection once. Show running counts and cancellation; import never launches the source, MCP, hook or model. Final summary lists each imported, unchanged, needs-setup, unsupported, failed and cancelled item. `설정 필요` links to existing model/MCP settings. Imported items remain editable and deletable through their normal Butler UI.
5. Closing the window does not cancel a durable apply; reopening shows its current result. Cancel stops between items/chunks and gives an accurate partial summary; already imported items remain and can be edited/deleted normally.

UI uses existing Settings shell and `SettingsPage` → `SettingsSection` (list/form/status) → `SettingsField`, `ListRow`, `Switch`, `Select`/`NativeSelect`, `Input`, `KeyValueRow`, `ProgressMeter`, `Spinner`, `Dialog`, `Typo`, `Button`/`ButtonContainer`, `Toaster`, `ScrollArea` from `@/butler-ds`. `SetupWizardShell` is only for onboarding outside the app shell. No custom CSS, raw controls/typography, inline styles or banners. Page lists in 100-row cursors, keeping all items reachable. Domain container owns IPC/state; DS owns presentation. Keyboard/focus/live status, reduced motion, Korean/English and 320/375/390/430px plus desktop are required smoke states; no UI unit tests or recordings.

CLI (proposed; not available today): `butler migrate detect --json`; `butler migrate preview --source codex --root <path> --project <mapping> --json`; `butler migrate apply --preview <id> --digest <hash> --json`; `butler migrate status <run-id> --json`; `butler migrate cancel <run-id>`. Interactive `butler migrate` guides the same flow. Noninteractive apply requires explicit selected item IDs/decisions bound to the preview; `--yes` acknowledges that plan, never selects extra data, approves effects or resolves conflicts. JSON is the redacted DTO, not raw source text. Exit 0 = requested operation complete, 2 = decisions/unsupported/stale input, 1 = operational failure; partial apply returns 2 with a durable run ID and summary.

## 6. Architecture, contracts and recovery

Extend existing owners, no new daemon or source-tool subprocess. `butler-runtime::migration` (proposed) owns data-only adapters, inventory/plan and a one-way apply journal; agent composition binds narrow destination ports. Existing instruction, Skills, model and MCP owners validate and mutate phase-1 items; schedule and archive owners are for later phases. `butler-turn::conversation` owns any later external archive in a separate inert namespace with source-read pagination; these records have no execution binding and are excluded from ordinary prompt/recall/recovery enumeration unless explicitly selected. Memory-document archive/projection lifecycle belongs to the later `butler-memory` phase. Gateway authenticates and projects; desktop and CLI call the same owner API. OS home/XDG/app-location discovery, no-follow file handles, ACL/permissions, file identity and snapshot helpers live **only in `crates/butler-platform`**. Ordinary parsing is portable; blocking file/SQLite work uses bounded `spawn_blocking` jobs, never tokio workers. No registry of arbitrary executable adapters.

Public contracts use `schema_version=1`; examples describe fields, not finished public APIs:

| DTO / command | Required content |
|---|---|
| `SourceDescriptor` | Opaque source ID, tool enum, profile ID, parser revision, recognized format, root display label, requested scope, availability. Canonical private root is server-side, never in telemetry. |
| `MigrationItem` | Stable source key, category, source revision/content digest, applicability/order, destination kind/ID, expected destination revision, dependencies, `ready\|unchanged\|conflict\|needs_review\|needs_secret\|unsupported\|error`, machine-readable reason codes. Metadata text is escaped and sanitized too. |
| `Preview` | ID, inventory revision, exact selected-item set and digest, source snapshot fingerprint, destination revisions, totals by category/disposition, complete-enumeration flag, cursor, needed secret slots (names only), conversion disclosures. Never apply an incomplete inventory. |
| `Apply` | Preview ID/digest, selected item decisions, request ID/payload hash. Changed source, destination or selection returns `preview_stale` before the affected item commits. No automatic conflict resolution. |
| `Receipt` | Run ID/state, monotonic revision, per-item destination ID/revision and result, counters, redacted reasons; excludes bodies, paths, command arguments, credentials and prior versions from generic events. |
| `ArchiveRecord` (later phase) | Source tool/profile/session/parent IDs, original sequence/time/role/part type, provenance offsets, local private content reference, explicit redaction/unsupported-part markers. Unknown parts retained as inert data only if safe; unavailable parts counted. |

Commands are exposed under authenticated `/migrations/{detect,previews,runs}` plus cancellation; later archive phases may add cursor reads. Reuse the existing event stream with `migration.progress` / `migration.completed` and `Last-Event-ID`/cursor semantics. Remote paired clients cannot nominate arbitrary server paths: local owner grants exact roots through a local-only picker/CLI, and endpoints accept only those opaque root handles. Browser routes retain existing CSRF/origin/auth controls. Lost events recover by receipt revision, not periodic scans.

### 6.1 Stable identity and source snapshots

Identity = tool + private root/profile ID + category + relative source identity + scope; digest = normalized supported payload plus required asset hashes, not the mutable display name. Store provenance aliases for shared physical paths (Codex/OpenCode/Claude may see the same `.agents` skill); same bytes in different scopes are not duplicates. Renames discovered by stable source IDs keep identity; ambiguous renames become conflicts. Open every source read-only: Butler never writes, renames or deletes source files. Source deletions never delete Butler objects on re-run.

Detect is read-only metadata. In phase 1, Preview reads selected configuration only and holds a bounded in-memory plan in the running Butler agent; it does not inspect memory, session-history or transcript data. Later archive phases may add metadata-only inventory before separate consent-gated content reads. There are no persistent preview writes or source cache. CLI invocations use that same agent, so closing a CLI does not destroy the preview. Explicit exported preview is sanitized. Preview expires on agent process exit or after 30 idle minutes, checked on the next request, with no timer polling. An expired preview requires regeneration.

Apply reopens with no-follow handles and validates file identity, size and digest against preview. Configuration is the only phase-1 input. For a later archive phase, JSONL readers freeze a complete-record byte boundary, stream records, detect replacement/truncation and preserve later appends for a later re-run; a partly written final record is pending, not discarded. SQLite archive readers use read-only connections and a consistent snapshot including WAL; never use `immutable=1` on a live database or copy only its main file. If a no-source-write snapshot cannot be obtained, require a supplied export or closed-tool snapshot; do not repair it. Bound readers and release snapshots after ingestion so writers are not held indefinitely.

### 6.2 One-way apply and re-run safety

Create a private per-run journal only on explicit apply, with intent and per-item outcomes but no previous-version copies, secrets or undo payloads. States: `prepared → applying → completed|partial|cancelled|recovery_required`. Persist intent before a destination write and outcome before announcing it. One active writer per destination scope; read-only previews may coexist. Startup reconciles unfinished work once and never scans completed sources at idle.

Each destination owner needs `prepare(expected_revision)`, `commit(operation_id,payload_hash)` and `lookup_operation` behavior at its existing write boundary. These are **required additions**, not claims that current APIs supply cross-domain transactions. Object + operation receipt must be recoverable together (same DB transaction, or an atomically published revision manifest for files). After crash-before-receipt, lookup returns committed identity; it never duplicates an item. Same request/key + different payload is a conflict. Publish selected files atomically through their owner. Imported items remain editable/deletable through normal Butler UI and owner APIs.

MCP secret bytes and files are never copied. Re-enter secrets through Butler when needed; keep an opaque source secure-store reference only when Butler has a supported integration to resolve it. Never retain a raw source auth-file path or secret value.

Apply is per-item atomic with a durable outcome receipt, not falsely all-or-nothing across stores. Stop on a failed dependency, continue independent selected items, and report the exact partial result. Skip is the conflict default; Keep both uses the previewed collision-free identity; Replace is explicit and uses destination CAS. Store stable source identity and digest with the imported object through its normal owner so an identical re-run is `unchanged` and creates no duplicate. Keep no prior-object snapshot or migration undo store; retain no undo payloads.

## 7. Security and performance contracts

Source content is untrusted data during migration. Dedicated credential files (`auth.json`, `.credentials.json`, `.env`, keychains, private key/certificate files) are excluded before opening; no credential-directory recursion. Mixed config (notably `.claude.json`) uses allowlisted extraction in memory, discarding unrelated sign-in fields without serialization. No secret fallback expression, helper command, env expansion, URL fetch or plugin code runs. All env/header literal values are withheld by default, including innocently named keys; approved non-secret literals can be entered separately. Reject URLs with userinfo or sensitive query fragments, and secret-bearing command arguments pending re-entry. MCP secret bytes/files are never copied: use an opaque source secure-store reference only through a supported Butler integration, otherwise ask the user to re-enter the secret in Butler. Never reference raw source auth files. OAuth reconnects through Butler.

Text and assets can also contain secrets. Scan selected content, surface findings for local review, and leave affected items unselected until excluded/redacted by the owner; scanning is not a proof of absence. Never silently rewrite instructions or claim redacted content is lossless. Binary/unknown assets stay excluded unless the owner explicitly reviews them. Private archives stay local and out of logs/repo/telemetry/model context; separate disclosure is required before recall ingestion or provider submission. No raw bodies in event payloads, parse errors, crash reports, test snapshots or exported reports. Test credentials/content are synthetic canaries only.

Constrain roots and include closure; prevent `..`, symlink/junction escape, path replacement and case/Unicode collisions. Symlink targets already in an approved root can be snapshotted once; targets outside need an explicit root grant. Never silently omit a linked asset required by an imported skill. Root validation covers reads, staging and targets. Private files use owner-only permissions/ACLs through platform APIs. File size/parser nesting limits yield an item error and resumable work, never a truncated “success”. Foreign managed policy is neither weakened nor advertised as enforced; inability to represent restrictions blocks related activation.

Budgets are **proposed acceptance targets**, not measurements. Benchmark on recorded SSD/CPU/OS with cold and warm results, while Butler holds the owner-scale fixture: App DB ~1.3 GB/600+ chats/300k events, BTCC ~7 GB, 2,440 transcripts/1.5 GB total/largest 290 MB, metrics >300 MB. Generate synthetic equivalents; never use owner data without separate consent.

| Operation | Budget and correctness requirement |
|---|---|
| Closed/completed migration UI, 10-minute idle | 0 source scans, 0 migration wakeup polls, **0 migration-attributable disk writes**; report whole-process background writes separately. No new recurring timer. |
| Detect four conventional roots + 20 selected projects | p95 ≤250 ms warm / ≤1 s cold; only bounded path metadata probes, 0 transcript/body reads; correct presence/error states, no hidden partial result. Slow roots return pending/error, not absent. |
| Setup preview: 1,000 items / 20 MiB + 10,000 asset entries | First UI acknowledgement ≤100 ms; complete preview p95 ≤2 s warm / ≤5 s cold; RSS delta ≤128 MiB. All items, conflicts, asset dependencies and counts must agree with fixture. |
| Later-phase owner-scale archive apply | Incremental RSS ≤192 MiB; ≤2 blocking readers, 1 destination writer, 1-MiB read chunks; aggregate sustained ≥20 MiB/s on warm local SSD, ≤120 s for 1.5 GB including local archive index (no embeddings). Verify every selected message/part, byte accounting, ordering, timestamps and latest snapshot boundary. |
| UI/status + competing chat | Indexed 100-row reads p95 ≤100 ms; receipt first paint ≤200 ms; migration adds ≤50 ms p95 to existing chat/control latency under stub load. No DB-wide or transcript scan on request path. |
| Cancel/progress/storage | Cancel acknowledged ≤200 ms, next safe chunk/item ≤1 s; emit at most 4 progress events/s while state changes, no per-chunk disk log. Budget transient staging ≤2× selected sanitized bytes + 64 MiB; check free space and fail before mutation if insufficient. |

Hash once per selected snapshot, stream large assets with backpressure, reuse destination owner indexes and bulk operations, and checkpoint without duplicating whole files. After interrupted apply, reconcile committed items and resume only the remaining selection. Re-run may rehash selected source files for correctness; it performs zero destination content writes for identical items. A progress event rate limit must not drop terminal transitions. Exceeding a budget triggers less redundant work, not smaller content, fewer records, lower fidelity or stale results.

## 8. Phases and acceptance

Implementation is separately authorized; branches start from integrated predecessors/current main, not a parallel plugin framework. Each phase adds public-path E2Es first in `R/crates/butler-e2e`. P1 is a complete configuration import for all four sources; do not advertise deferred data categories as migrated.

| Branch | Vertical slice / acceptance |
|---|---|
| `codex/migration-configuration` / P1 | All four source adapters through the same Settings/CLI path: scoped global/project 지침; skills; commands/agents only where they map; MCP config; model/provider preferences. Four source-specific E2Es pass before exposure. Preview is exact, selection is per item, Skip/Keep both/Replace are explicit, default never overwrites existing Butler data, identical re-run creates no duplicates, source hashes remain unchanged, and imported items use normal Butler edit/delete UI. |
| `codex/migration-policies-schedules` / P2 | Later import/report of hooks, permissions and recognized schedules. Preserve restrictions; schedules start paused and require a Butler target. No source execution or policy widening. |
| `codex/migration-archives` / P3 | Opt-in memory/reference documents and session/history archives for all four; JSONL, OpenCode export/SQLite/legacy and Hermes SQLite; full page/source-read UI and CLI, private provenance, no false Work/Task creation. Archive completeness, privacy and owner-scale E2Es pass. |
| `codex/migration-acceptance` / P4 | Combined app+CLI stub/replay, interruption/restart, supported-platform filesystem cases, responsiveness/idle/owner-scale budgets, DS mobile/desktop smokes and batch CI evidence. Complete per-item accounting and no imported secret canaries. No default-on rollout without separate authority. |

E2E matrix (new fixtures are synthetic and version-pinned; no copying local instruction/config/history bodies):

| Case | Public-path evidence |
|---|---|
| MIG-CFG-01 Codex (P1) | TOML layers/profiles, AGENTS override/fallback, both skill locations, shared symlink, mappable agents/commands, MCP/model preferences and secret canaries. Exact selection and scope, original hashes unchanged, no auth-file open. |
| MIG-CFG-02 Claude (P1) | Global/project/local instructions, CLAUDE/AGENTS precedence, path rules/includes, skills/legacy commands/mappable agents, `.claude.json` and `.mcp.json`, model preferences. Scope preserved; shell interpolation never executes; no history read. |
| MIG-CFG-03 OpenCode (P1) | XDG/custom roots, JSONC, plural/singular skill folders, shared skills, mappable commands/agents, local/remote MCP and model preferences. No plugin execution, storage migration or history read. |
| MIG-CFG-04 Hermes (P1) | Custom HERMES_HOME/two profiles, YAML model/provider settings, SOUL/project instructions, categorized skills, mappable prompts, MCP and secret references. No plugin execution, memory/state DB, cron or session read. |
| MIG-EXT-05 Shared safety (P1) | Inject canaries in auth paths, config literals, text/assets, args/URLs and malformed parser errors; forbidden-file-open counter is zero, secrets absent from logs/events/reports. Exact preview, per-item selection, Skip/Keep both/Replace, unchanged source hashes, traversal and symlink/junction escapes rejected. |
| MIG-EXT-06 Lifecycle (P1) | Repeat identical run, change source/destination, same request ID/different payload; crash after intent, destination commit or receipt. No duplicates or lost user edits; explicit Replace is revision-checked; cancellation returns an accurate partial result; summary and normal UI edit/delete work. |
| MIG-EXT-07 Boundaries (P1) | Settings and CLI results agree; source tools/providers/hooks never run; only selected settings change, unselected Butler values/EOL/access stay unchanged; no memory/session/transcript reads or Work/Task creation. |
| MIG-EXT-08 Later archives (P3/P4) | Full archive counts, digests, order/latest snapshot, cursor traversal, complete source reads, RSS/throughput/chat latency and 10-minute idle I/O. DS states cover empty, inaccessible, loading, conflict, partial, reconnect and cancellation. |

Reuse existing affected-path coverage: `R/crates/butler-e2e/tests/{skills_disclosure,mcp,personalization,personalization_defaults,durable_configuration,cli_surface,migration,schedule_store,schedule_calendar,schedules}.rs`, especially rejected legacy data-dir migration and durable config. Non-E2E only where necessary with `// test-category: pure-logic` (scope/recurrence conversion), `format-pin` (wire/parser schema), `security` (root/secret extraction), or `race` (CAS/receipt boundary). Test-count/source-check ratchets never increase; prioritize extending existing E2Es. Files ≤500 lines, production functions ≤80; split by adapter/domain responsibility, not forwarding wrappers.

Every check/test gets a fresh temporary HOME/BUTLER_DATA under TMPDIR and cleanup, with stub/replay only. Future browser smokes use `--single-process` here without weakened assertions. P1 runs each source E2E and relevant existing coverage, plus `cargo fmt`, touched-crate clippy `-D warnings`, source-check and frozen Bun install/check for TS/UI changes. Coordinator batches PR/CI; this design branch opens no PR, tags nothing and merges nothing.

## 9. Self-review, decisions and remaining proof

- Scope review: one feature/issue; all four sources and requested data categories mapped; no product changes, real Butler reads/writes, secret/body publication, runtime or migration execution.
- Ownership review: portable parsing in runtime, OS handling in platform, destination writes through existing owners; explicit new CAS/applicability/paused-create gaps rather than pretending current APIs already suffice.
- Safety/fidelity review: source untouched, permissions never widened, exact preview authority, shared-source identity, full selected-content accounting, non-executable history and no false work-model acceptance; failed dependencies/unknown formats remain visible.
- Recovery review: per-item durable outcome rather than cross-store atomicity claim; source stays read-only, competing target edits, crash-before-receipt, cancellation and idempotent re-run are defined without undo storage.
- Performance/UI review: owner-scale inputs and numerical complete-result budgets; no polling/idle writes/model calls, existing DS catalog selection, short copy and actual public-path E2Es/smokes.

**Owner decisions (2026-10-03):**
1. Phase 1 ships configuration only across all four sources: scoped 지침, skills, mappable custom commands/agents, MCP configuration and model/provider preferences. Memory, session history/transcripts, schedules, hooks/permissions and all other data move to later phases.
2. Migration is one-way (“migrate and done”): no rollback/undo store or 30-day retention. Safety comes from read-only sources, exact preview, per-item selection, Skip/Keep both/Replace with Skip as the non-overwriting default, idempotent re-run, a final per-item summary and normal Butler UI edit/delete.

Implementation, E2Es/smokes, runtime/performance/platform measurements and rollout remain undone by design (§8). Numerical budgets are targets; local counts in §2.1 are observations only. Source schema/version fixtures must be pinned again when implementation begins, especially evolving Codex history, OpenCode SQLite/V2, and undocumented Codex schedule records. No canonical Project Ledger publication is performed because this task prohibits real `~/.butler` access and explicitly requests a repository design artifact.

Revision validation (design-only): isolated `cargo fmt --all -- --check` and `cargo run -p butler-source-check -- .` passed from `packages/butler-agent/rust` (2,181 Rust files; 1,768 modules / 48 domains; architecture and E2E gate violations 0). `git diff --check` passed; the environment emitted a non-fatal xcrun cache warning. The plan has four source-specific P1 E2Es and eight cases total; no Rust/TS/UI product file changed, so clippy, Bun, runtime E2Es and smokes are not applicable. These checks do not measure migration behavior or performance.

## 10. Primary references

All links below were accessed **2026-10-03**; public docs are rolling sources, not guarantees about every installed version. Repository links pin the inspected revision. Paraphrased findings above distinguish supported contracts from observations and proposed Butler behavior.

| ID | Official source(s) |
|---|---|
| C1 | [Codex configuration reference](https://developers.openai.com/codex/config-reference/) (redirects to OpenAI's ChatGPT Learn). |
| C2 | [AGENTS.md resolution](https://developers.openai.com/codex/guides/agents-md/). |
| C3 | [Codex skills and discovery](https://developers.openai.com/codex/skills/). |
| C4 | [Codex custom subagents](https://developers.openai.com/codex/multi-agent/). Legacy prompt layouts are adapter candidates, not verified local data. |
| C5 | [Codex hooks, locations and trust](https://developers.openai.com/codex/hooks/). |
| C6 | [Codex app-server thread operations](https://developers.openai.com/codex/app-server/). |
| C7 | [Local versus hosted memories](https://learn.chatgpt.com/docs/customization/memories). |
| C8 | [Codex rollout facade](https://github.com/openai/codex/blob/c542fb93ef4b49c06e854e1cde9f892e8d3e8094/codex-rs/core/src/rollout.rs), [SQLite state metadata](https://github.com/openai/codex/blob/c542fb93ef4b49c06e854e1cde9f892e8d3e8094/codex-rs/state/src/lib.rs). |
| C9 | [Scheduled tasks / recurrence and local execution](https://learn.chatgpt.com/docs/automations). |
| A1 | [Claude instructions, rules, imports and auto memory](https://code.claude.com/docs/en/memory). |
| A2 | [Claude skills and legacy commands](https://code.claude.com/docs/en/skills). |
| A3 | [Claude subagents and memory scopes](https://code.claude.com/docs/en/sub-agents). |
| A4 | [Claude MCP scopes and environment references](https://code.claude.com/docs/en/mcp). |
| A5 | [Claude settings and precedence](https://code.claude.com/docs/en/settings). |
| A6 | [Claude hooks / transcript paths](https://code.claude.com/docs/en/hooks). |
| O1 | [OpenCode config layers](https://opencode.ai/docs/config/). |
| O2 | [OpenCode rules and compatibility](https://opencode.ai/docs/rules/). |
| O3 | [OpenCode skills](https://opencode.ai/docs/skills/). |
| O4 | [OpenCode commands](https://opencode.ai/docs/commands/). |
| O5 | [OpenCode agents](https://opencode.ai/docs/agents/). |
| O6 | [OpenCode MCP](https://opencode.ai/docs/mcp-servers/). |
| O7 | [OpenCode plugins](https://opencode.ai/docs/plugins/). |
| O8 | [OpenCode permissions](https://opencode.ai/docs/permissions/), [V2 permission dialect](https://opencode.ai/v2/docs/permissions). |
| O9 | [OpenCode storage documentation](https://opencode.ai/docs/troubleshooting/), [CLI export](https://opencode.ai/docs/cli/#export). |
| O10 | At `108b988a08227df45417f27905a4d6b27ad49b6d`: [XDG paths / startup writes](https://github.com/anomalyco/opencode/blob/108b988a08227df45417f27905a4d6b27ad49b6d/packages/core/src/global.ts), [SQLite path](https://github.com/anomalyco/opencode/blob/108b988a08227df45417f27905a4d6b27ad49b6d/packages/core/src/database/database.ts), [legacy storage](https://github.com/anomalyco/opencode/blob/108b988a08227df45417f27905a4d6b27ad49b6d/packages/opencode/src/storage/storage.ts), [export sanitization](https://github.com/anomalyco/opencode/blob/108b988a08227df45417f27905a4d6b27ad49b6d/packages/opencode/src/cli/cmd/export.ts). |
| H1 | [Hermes configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration/). |
| H2 | [Hermes context files](https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files/), [profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles). |
| H3 | [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/). |
| H4 | [Hermes plugin hooks and commands](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins). |
| H5 | [Hermes MCP reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference). |
| H6 | [Hermes security / approval policy](https://hermes-agent.nousresearch.com/docs/user-guide/security/). |
| H7 | [Hermes memory / session SQLite](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/). |
| H8 | [Hermes cron storage and execution](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron). Official repo inspected at `387c78c8f7f2f552605de006ccec13ee9427d7a2`; docs remain rolling. |
