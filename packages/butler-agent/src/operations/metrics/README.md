# metrics operations

`packages/butler-agent/src/operations/metrics/` owns raw-text-free diagnostics for
context pressure, runtime operations, and model-provider usage.

## SPEC-AGENTIC-CORE-USAGE-MONITORING

Usage monitoring exists to identify where Butler spends provider requests and
tokens. It must record enough attribution to explain excessive usage without
changing whether a legitimate turn is allowed to continue.

Success criteria:

- Provider usage records include request counts, prompt tokens, cached prompt
  tokens, output tokens, total tokens when available, provider/model, scope,
  turn id, phase, reasoning effort, prompt-cache metadata, and prompt section
  attribution.
- Live usage state may expose request/token warning thresholds, but the default
  runtime must not throw, abort, or reduce model-call rounds solely because a
  turn crossed a token threshold or model-call count.
- Any future hard cap must be explicitly opted into by the caller or operator
  and disabled by default. The default response to high usage is telemetry and
  warning status.
- Usage summaries must not include raw prompts, raw tool arguments, raw tool
  results, credentials, raw URLs, or private memory text.

## Runtime memory-footprint boundary

Status and context-monitor reads use the shared chunked JSONL scanner. They
aggregate one record at a time and retain only bounded maps/reservoir samples;
they never materialize a historical telemetry or transcript log with
`readFileSync(...).split("\\n")`. Context transcript counters additionally
persist a metadata-only checkpoint under `metrics/transcript-summary/`, so an
append-only timer tick reads the appended byte window and a restart can resume
from the same byte cursor. Rotation, truncation, and malformed tails invalidate
or replay only the affected checkpoint boundary; canonical transcript text
stays in its owning store.

Provider SSE consumers drain normal completion and always cancel/release the
reader on parse failure, provider failure, timeout, abort, or abandoned
consumption. Abort listeners are removed after the reader settles, and stream
cleanup never replaces the primary provider error.
