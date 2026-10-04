# Subscription cache experiment — 2026-10-05

Adding only `session-id`, equal to the existing body `prompt_cache_key`, changed request-two caching from **0% to 97.06%** across five independent pairs. The implemented Rust provider confirmed **97.05%**; a fresh unchanged baseline confirmed **0%**. Every winning second request reported **11,776 cached tokens** from approximately **12,133 input tokens**.

## Source comparison

Butler baseline: `d961c2434`, historical TypeScript: `37a530825`.
Current official Codex source was fetched and pinned at `c2f7fe89d87ce853900d0b5cb1f5dc4863e44d73`:
[core client](https://github.com/openai/codex/blob/c2f7fe89d87ce853900d0b5cb1f5dc4863e44d73/codex-rs/core/src/client.rs),
[ResponsesApiRequest](https://github.com/openai/codex/blob/c2f7fe89d87ce853900d0b5cb1f5dc4863e44d73/codex-rs/codex-api/src/common.rs),
[session headers](https://github.com/openai/codex/blob/c2f7fe89d87ce853900d0b5cb1f5dc4863e44d73/codex-rs/codex-api/src/requests/headers.rs),
[HTTP Responses transport](https://github.com/openai/codex/blob/c2f7fe89d87ce853900d0b5cb1f5dc4863e44d73/codex-rs/codex-api/src/endpoint/responses.rs),
[default client](https://github.com/openai/codex/blob/c2f7fe89d87ce853900d0b5cb1f5dc4863e44d73/codex-rs/login/src/auth/default_client.rs).

| Field | Rust subscription baseline | TS snapshot 37a530825 | Current Codex normal Responses path |
| --- | --- | --- | --- |
| Model / endpoint | Catalog model; strip legacy `-codex`; subscription `/codex/responses` | Same | Model slug; subscription `/codex/responses` |
| `prompt_cache_key` | Configured or data-root-derived `butler:<12 hex>` prefix, plus sanitized caller scope | Same scheme | Session ID, optional override; internal agents can use parent thread scope |
| `store` | `false` | `false` | `false` |
| `include` | Absent | Absent | `reasoning.encrypted_content` |
| Prior reasoning items | Stateless/bounded assistant projection retains visible text and calls; drops reasoning | Model-round stateless continuation appends calls, not reasoning | Replays response items including encrypted reasoning in history |
| `previous_response_id` | Removed on subscription path | Removed | HTTP sends full input; WebSocket continuation can send delta and previous response ID |
| `parallel_tool_calls` | Absent | Absent | Explicit bool from prompt configuration |
| Reasoning | Requested effort | Requested effort | Effort plus optional summary; `context: all_turns` for Responses Lite |
| Text | Medium verbosity fallback; background prompts can include output schema | Same fallback | Model-supported default/configured verbosity and optional schema |
| Instructions | Custom Butler instructions, helpful-assistant fallback | Same | Caller base instructions; normal Responses does not force a hardcoded official string |
| `session-id` / `thread-id` | Absent | Absent | Cache-affinity session ID / actual thread ID |
| `session_id` / `conversation_id` headers | Absent | Absent | Neither emitted by current session-header builder; legacy session spelling worked in experiment |
| `x-client-request-id` | Absent | Absent | Thread ID |
| `originator` / User-Agent | Butler / Butler OS facts, configurable | Same | Default `codex_cli_rs` / Codex version and OS facts, overridable |
| `OpenAI-Beta` | `responses=experimental` | Same | Normal HTTP builder does not add this legacy beta; WS uses a WebSocket beta |
| `chatgpt-account-id` / authorization | Account claim / bearer subscription token | Same | Account ID / bearer subscription token |
| `service_tier` | Absent | Absent | Optional model-supported tier; omitted by default |
| `stream` / options | `true`; no stream options | Same | `true`; optional sequential reasoning-summary delivery |
| Turn routing / metadata | No turn-state echo or client metadata | Same | Per-turn server state echo and client metadata; optional routing/beta headers |

The decisive source evidence is `ModelClient::responses_session_id`: its comment explicitly identifies the Responses session header as ChatGPT cache affinity and makes the root-agent header match the prompt cache key. Body order and the body key alone do not supply that identity.

The selected historical TS snapshot matches Rust for these subscription fields. This experiment establishes the present affinity failure, not when it began or why earlier TS runs had higher cache shares.

## Live design and measurements

Used only `openai/gpt-6-luna`, low effort, exactly `OK` visible output, and the existing E2E-supported read-only Codex auth fallback. Each run copied auth into a fresh temp profile with isolated HOME/BUTLER_DATA and deleted it afterward. The documented Butler test profile was absent on this host.

The prefix is synthetic, **12,013 o200k tokens**, plus a tiny tool schema and instructions. Each pair gets a unique marker at the start and a fresh stable cache identity. Request two preserves the complete first input and appends the assistant output and a short user item. There are five pairs / ten calls per variant. Variant order is deterministically shuffled within each replicate. All 200 measured calls completed and asserted the expected full output and numeric usage fields; no response content or credentials are retained. Percentages below are token-weighted across second requests, with the per-request range and count reaching 90%.

The baseline body was emitted by the actual Butler serializer through an ephemeral loopback capture. Candidate HTTP/SSE requests changed only the stated body/header fields. The final patched measurements ran through the actual Rust `ModelProvider`, serializer, reqwest transport and SSE decoder. The CLI-equivalent variant matches current **normal Responses HTTP/SSE** fields; it does not run Codex's WebSocket or Responses Lite paths. It uses the official base prompt plus the original custom prompt as a developer input, so its input is larger (about 16,502 tokens).

| Variant | Request-two cached share | Range | ≥90% pairs |
| --- | ---: | ---: | ---: |
| Current Rust request | 0.00% | 0.00–0.00% | 0/5 |
| Add `session-id = prompt_cache_key` | 97.06% | 97.04–97.08% | 5/5 |
| Add legacy `session_id = prompt_cache_key` | 97.06% | 97.05–97.07% | 5/5 |
| Add `conversation_id` only | 19.41% | 0.00–97.05% | 1/5 |
| UUID body cache key only | 0.00% | 0.00–0.00% | 0/5 |
| Request encrypted reasoning and replay output | 0.00% | 0.00–0.00% | 0/5 |
| `parallel_tool_calls: true` only | 19.41% | 0.00–97.03% | 1/5 |
| `reasoning.summary: auto` only | 0.00% | 0.00–0.00% | 0/5 |
| `text.verbosity: low` only | 0.00% | 0.00–0.00% | 0/5 |
| `originator: codex_cli_rs` only | 0.00% | 0.00–0.00% | 0/5 |
| Remove OpenAI-Beta only | 0.00% | 0.00–0.00% | 0/5 |
| Codex HTTP headers only | 97.05% | 97.02–97.07% | 5/5 |
| Official base instructions; custom instructions in input | 4.34% | 0.00–21.71% | 0/5 |
| Codex normal Responses HTTP/SSE fields and headers | 96.18% | 96.17–96.19% | 5/5 |
| Echo returned `x-codex-turn-state` only | 0.00% | 0.00–0.00% | 0/5 |
| Confirmation: baseline | 0.00% | 0.00–0.00% | 0/5 |
| Confirmation: patched-rust | 97.05% | 97.03–97.07% | 5/5 |

A separate numeric-check follow-up tested baseline, encrypted replay and the session header with five more pairs each. Baseline and encrypted replay remained **0%** on every second request; the session header stayed **96.87–96.93%**. One encrypted-replay first request produced an actual encrypted reasoning item (65 output tokens including reasoning); the second request replayed that item and still reported zero cached tokens. This is limited evidence about nonempty reasoning replay, but establishes that requesting/replaying reasoning is not required for the winning header result.

[Content-free per-request measurements](subscription-cache-metrics-2026-10-05.jsonl) contain discovery, confirmation and reasoning stages. An initial direct-Rust probe completed one extra first request, then stopped because the probe incorrectly expected raw API status/usage instead of Butler's normalized response. Its extraction was corrected; that unpaired warm-up is excluded from the 200 measured calls.

## Implementation and limits

`provider/route.rs` adds a shared helper that puts the existing prompt cache key into `session-id` for Codex auth, accepting only valid header values. `provider/client.rs` and `provider/prompt.rs` apply it before freeing the parsed body. This covers foreground model rounds and background prompts, without changing payload fields, caller scopes, instructions, tools, output fidelity, retries or budgets. No scenario code or new tests were added.

The owner's supplied macOS diagnostic path was absent on Linux; the 135-row Windows trace could not be independently read. The owner-provided trace findings are context, not locally verified measurements. Live results are from Linux with this account, rather than a rerun of that Windows build. Future long-session behavior and transport-specific differences remain outside this two-request experiment.

## Validation

Final checks use the repository's pinned Rust 1.91 from the Rust workspace, with fresh HOME/BUTLER_DATA per command. Initial commands from the repository root selected host Rust 1.98; its fmt discovery and dependency lint failures were environment mistakes, not reasons to change unrelated production code. All temporary probe sources were removed.

- `cargo fmt --all` and `cargo fmt --all -- --check`: passed.
- `cargo clippy -p butler-models --all-targets -j 8 -- -D warnings`: passed on pinned Rust 1.91.
- `cargo test -p butler-models --lib -j 8 -- --test-threads=8`: 65 passed, 0 failed; the one ignored entry is an MCP child fixture exercised by its parent tests.
- `cargo run -p butler-source-check -j 8 -- .`: passed, zero violations, unchanged test/function baselines.
- `git diff --check` and measurement integrity checks: passed.

Pinned test compilation initially failed with a read-only-filesystem error while using the host sccache wrapper. The same test command with direct compilation (`RUSTC_WRAPPER=`) passed; the workspace itself was independently verified writable. No process or shared cache service was stopped. Source-check also used direct compilation. No new tests, TypeScript/UI changes, PR, tag or merge are part of this delivery.
