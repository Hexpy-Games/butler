# Qwen summary failure investigation — 2026-09-09

Scope: read-only diagnosis plus bounded inference probes on the existing local
server. No production code, model settings, service restart, or Work mutation.

## Incident and reproduction
- Final Steward error: context_summary_empty_response at 21:10:15 KST.
- Earlier 120-second idle timeout at 21:07:10 recovered on its second attempt.
- Server reports vLLM 0.27.1. Model local/qwen3.8-27b.
- Reconstructed the single-message summary input from developer capture.
  SHA-256 b029562b6c92e66df3044a0c7818e0b834d10daba393e050eb004b2af63791f9
  matches the original summary round source digest. No redaction markers.
- Same messages, temperature 0, max_tokens 4096, no tools or reasoning override.
  Stream comparison adds only stream=true and usage reporting.
- Nonstream replay: HTTP 200, 57.199 s, 29210 prompt tokens, 4096 completion
  tokens, finish=length, content 0 characters, reasoning 14654 characters.
  Entire message object equals the original stored response.
- Stream replay: HTTP 200, 47.662 s, first SSE 0.512 s, 1719 SSE JSON events,
  same token counts and finish=length, content 0, reasoning 14654 characters.
- Original, nonstream and assembled stream reasoning SHA-256 all equal
  63ff08ea9350f25837e8dbc2f6db7638c2aa6122398abf298455c3e519d22929.
  Thus stream alone does not repair this incident.

## Prompt inspection
The server render endpoint returns 29210 input tokens for the same request.
Detokenizing the final tokens shows the prompt ends with assistant + open
<think>, not a pre-closed thinking block. Adding top-level reasoning_effort=none
changes the tail to <think> followed by </think> before generation.

The local adapter does not forward request.reasoningEffort. Its current
localReasoningRequestParams only accepts config.reasoning_budget_ratio, which
is unset. Runtime metadata says none but the server receives neither none nor
enable_thinking=false. Configured max_output_tokens is 4096.

## External corroboration and limits
- https://github.com/vllm-project/vllm/issues/53284 describes template/parser
  mismatch and both stream/nonstream variants. It is relevant but does not prove
  this incident: the actual default prompt has an open, not closed, think block.
- https://github.com/vllm-project/vllm/blob/v0.27.1/vllm/parser/qwen3.py
  initializes reasoning based on enable_thinking and changes to content on the
  closing marker.
- https://github.com/vllm-project/vllm/blob/v0.27.1/vllm/entrypoints/openai/chat_completion/protocol.py
  maps top-level reasoning_effort=none to enable_thinking=false.
Server-side local patches and launch arguments are not available over SSH;
claims about deployed behavior rely on live HTTP render/generation probes.

Raw inputs/outputs are restricted local diagnostics in
/tmp/butler-qwen-stream-investigation; no transcript or reasoning text is included
in this report. Raw-generation control: /v1/completions with exactly the rendered prompt token
IDs, temperature 0 and max_tokens 4096 returned 14654 characters in 47.609 s,
finish=length. No opening/closing think marker occurs in generated text. Its
SHA-256 matches the original reasoning and both replay modes exactly. This
bypasses chat reasoning extraction and rules out hidden completed content in
this reproduced generation. Explicit-none control: same message, temperature, nonstream mode and 4096-token
cap, adding only reasoning_effort=none returned finish=stop, 1680 completion
tokens, 3054 visible characters and zero reasoning characters in 39.712 s.
The prompt token count becomes 29170 because the template applies thinking-off.

## Conclusion and next correction
This incident is reproduced identically with and without streaming and without
chat parsing. The actionable cause is that the local adapter drops the selected
none reasoning setting, so the deployed server renders an open thinking prompt.
Generation reaches the 4096 cap before closing thinking. The compactor rejects
the resulting empty summary; the later parent response separately repeats the
empty/length shape. Explicit none resolves the summary reproduction without
raising the token limit or enabling streaming.

A bounded correction should transmit the chosen reasoning setting using the
verified backend contract, preserve thinking when selected, and classify
length-truncated empty responses explicitly. Streaming remains relevant to idle
progress detection but is not the proven fix for this summary failure. No repair
has been made during this investigation, and no whole user Work was rerun.
