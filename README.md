# butler

A personal AI butler with a native `codex-api` runtime by default. Receives tasks via Telegram, dispatches them to background workers, and reports results asynchronously.

---

## Status: Pre-release (v0.1.0)

This project is in alpha. Breaking changes are possible between minor versions until v1.0. Butler targets macOS and Linux; v0.1.0 is verified on macOS, with Linux verification deferred. The intended use case is a single-user personal butler running on your own machine. There is no SLA and no guarantee of backward compatibility during the alpha series.

---

## Requirements

- git
- jq
- Butler-managed runtime — prepared automatically by `install.sh`
- OpenAI Codex / Responses API runtime
  - stable auth: `OPENAI_API_KEY`
  - optional auth: Codex subscription login through Butler's browser OAuth flow

---

## Quick Start

```bash
git clone <butler-repository-url> ~/butler
cd ~/butler
./install.sh
```

If Butler is already available on your `PATH`, the equivalent product command
is:

```bash
butler install --home ~/butler --data ~/.butler
```

`install.sh` now bootstraps the native-primary runtime path in one flow:

- creates `$BUTLER_DATA/butler.config.json` from the template
- writes or updates `$BUTLER_DATA/.env`
- prepares a private Butler runtime under `$BUTLER_DATA/runtime/bun`
- prompts for `OPENAI_API_KEY` or Codex subscription login when `codex-api` is selected
- lets you choose the web page reader backend; the default is Butler's lightweight local reader, with Lightpanda available as an experimental optional renderer
- pairs one Telegram chat by asking you to message the bot, then stores the bot token/chat id in `$BUTLER_DATA/.env`
- offers OS user-service registration with `Yes` as the recommended choice, so Butler can start automatically after login
- installs dependencies and starts or registers native Butler services unless skipped

Default paths:

- `BUTLER_HOME=~/butler`: code/runtime home, safe to recreate from the release
- `BUTLER_DATA=~/.butler`: private user state, memory, transcripts, tasks, logs, auth/config, and managed runtime binaries

You can override either path:

```bash
./install.sh --home ~/Apps/butler --data ~/.butler
```

For scripted installs, OS service registration is opt-in only:

```bash
./install.sh --non-interactive --register-service
./install.sh --non-interactive --no-register-service
```

If you skip registration during install, you can add automatic startup later:

```bash
butler service install --yes
```

After the installer finishes, the normal checks are:

```bash
butler commands
butler status
butler ps
butler metrics status
butler doctor --check delivery --verbose
```

See Project Ledger record `REF-CLI-REFERENCE - Butler CLI Reference` for the
full command surface.
See [`.env.example`](.env.example) for all available environment variables.

## Repository Layout

Butler keeps source code, operations, product resources, and private runtime data
separate:

- `packages/butler-agent/`: headless Butler agent product, including source,
  resources, operational scripts, and agent-owned integrations
- `packages/butler-app/`: optional desktop app product, with app client,
  app-local server, shared protocol, and app validation scripts
- `packages/project-ledger/`: portable Project Ledger CLI, schemas, renderer,
  docs migration support, and distributable skill files
- `tools/`: repo-wide lint, validation, release, setup, and evaluation tools
- `tests/`: review gates and automated checks
- `$BUTLER_DATA/`: local private runtime state, outside the git checkout by default

For example, `packages/butler-agent/src/agent/cognition/memory/` is the
memory-store code, while
`$BUTLER_DATA/cognition/memory/` is your private memory store. By default,
`BUTLER_HOME` is the visible source checkout at `~/butler`, and
`BUTLER_DATA` is the private state root at `~/.butler`.

Each major module folder has its own `README.md` with a short module overview,
important files, boundaries, and `SPEC-ID - Title` references back to the
governing Project Ledger specs.

## Runtime Selection

Butler uses a native `codex-api` backend for workers and utility LLM tasks.
The TypeScript runtime is Bun, but Butler manages its own pinned Bun binary so
users do not need a global Bun install. Advanced users can override the runtime
with `BUTLER_BUN=/absolute/path/to/bun`.

Native-primary setup:

1. Stable: set `OPENAI_API_KEY` in `$BUTLER_DATA/.env` or your shell environment for official API billing
2. Optional: use Codex subscription login from `install.sh` to use ChatGPT/Codex subscription usage
3. Leave `system.runtime` as `codex-api` in `$BUTLER_DATA/butler.config.json` or set `BUTLER_RUNTIME=codex-api`
4. Optionally set `system.openaiModel` (default: `gpt-5.5-codex`)

When `codex-api` is enabled, worker dispatch, review, hot-cache summarization, cache compaction, and memory import use the OpenAI backend.

Butler does not require the Codex CLI or Codex desktop app. Its Codex subscription OAuth profile is stored under `$BUTLER_DATA/auth/openai-codex.json`. API key auth remains the official OpenAI API billing path and uses `/v1/responses`; Codex subscription auth is a separate Butler-owned transport that talks to the Codex backend with `originator=butler`. The default model is the concrete Codex-family alias `gpt-5.5-codex`, which subscription auth normalizes to the backend model name `gpt-5.5`. The legacy special model value `auto:codex-latest` remains accepted for explicit manual selection, but it is not the install or runtime default because it depends on provider model-discovery permissions.

### Web Search And Page Reading

Butler separates URL discovery from page reading:

- `webSearch.provider`: search provider, such as `duckduckgo-html`, `auto`, `brave`, `tavily`, `openai-web-search`, or `codex-subscription-web-search`
- `webSearch.readerBackend`: page evidence backend, such as `lightpanda`, `lightweight`, `jina-hosted`, or `disabled`

The default search provider is `duckduckgo-html`, so a clean install can search without a separate API key. Key-based providers such as Brave, Tavily, and OpenAI web search are optional; if a selected key-based provider fails because of a missing, invalid, expired, or rate-limited key, Butler falls back to DuckDuckGo HTML search. The default reader backend is `lightweight`. Butler treats Lightpanda as an experimental optional external AGPL-3.0 renderer backend, not MIT Butler source. If it is selected but not installed or not usable, Butler still returns evidence from the lightweight local reader and records a warning.

### Telegram Pairing

During install, Butler asks for a Telegram bot token and waits until you send a message to that bot. The detected chat becomes the paired Butler chat and is written to both `$BUTLER_DATA/.env` and `$BUTLER_DATA/butler.config.json`. The live service reads credentials only from `$BUTLER_DATA/.env` and owns its own `getUpdates` polling loop.

### Operational Reliability

Butler treats task completion and message delivery as separate states. A worker
or planned report can finish successfully while transport delivery is still
pending or failed. Delivery notifications live under
`$BUTLER_DATA/runtime/task-notifications/` and remain retryable until marked
delivered.

The status context and doctor surfaces expose the active reliability state:

- delivery backlog: pending, failed, delivered, and last error
- task recovery: running, recoverable, and failed task counts
- web search and page reader backend state
- managed runtime, auth, Telegram pairing, and native service health

The operator CLI groups common commands so you do not need to remember
individual script paths:

```bash
butler status
butler ps
butler logs --service butler-main --lines 100
butler metrics status --json
butler metrics tail --lines 20
butler metrics disable
butler metrics enable
butler context prune --json
butler start
butler stop
butler restart
```

Operational metrics are enabled by default and stored locally at
`$BUTLER_DATA/metrics/operational-events.jsonl`. They are diagnostic counters,
latencies, statuses, and safe dimensions only. Raw prompts, messages, tool
arguments/results, URLs, credentials, and private memory text must not be stored
in metrics. Set `BUTLER_METRICS_ENABLED=false` or
`metrics.enabled=false` in `$BUTLER_DATA/butler.config.json` to stop new
operational metric writes.

If Butler restarts while a worker is running, stale `RUNNING` tasks with enough
durable context become `RECOVERABLE`; `resume_worker` can continue them only
after that state is proven.

### Prompt Caching Notes

When using the official OpenAI Responses API, prompt caching is automatic for repeated prompt prefixes, but the prompt layout still matters:

- keep stable instructions and tool declarations ahead of task-specific text
- keep volatile task/request content at the end of the prompt
- use `system.openaiPromptCacheKeyPrefix` or `BUTLER_OPENAI_PROMPT_CACHE_KEY_PREFIX` only if you want an explicit routing hint
- use `system.openaiPromptCacheRetention` or `BUTLER_OPENAI_PROMPT_CACHE_RETENTION` only when you intentionally want `in_memory` or `24h`

`24h` retention can improve cache hit rates for low-frequency but repeated workloads, but it is a provider-specific retention choice and should be treated as an explicit operational decision rather than a silent default.

## Updating

```bash
cd $BUTLER_HOME && git pull
butler restart
# Your $BUTLER_DATA directory is never touched by git pull
```

---

## Contributor Verification

Maintainer and release checks are package scripts, not user CLI commands:

```bash
BUTLER_BUN="${BUTLER_BUN:-$BUTLER_DATA/runtime/bun/current/bin/bun}"
export PATH="$(dirname "$BUTLER_BUN"):$PATH"
"$BUTLER_BUN" run check
```

Current architecture and product contracts live in Project Ledger. Useful
records:

- `REF-ARCHITECTURE` - Butler Architecture
- `REF-ROLES` - Butler Role Model
- `REF-MEMORY-ARCHITECTURE` - Butler Cognition Architecture
- `REF-PROJECT-STRUCTURE` - Butler Project Structure
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-OPENAI-AUTH-AND-MODELS` - OpenAI Auth And Model Discovery
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-OPERATIONAL-METRICS-AND-CLI` - Operational Metrics And CLI
- `SPEC-WEB-SEARCH-TOOL` - Web Search Tool
